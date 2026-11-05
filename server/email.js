const EMAIL_TIMEOUT_MS = 15_000;

export function isEmailConfigured(env = process.env) {
    return Boolean(env.GOOGLE_APPS_SCRIPT_URL?.trim() && env.GOOGLE_APPS_SCRIPT_SECRET?.trim());
}

// Google Apps Script Web Apps answer a POST with a 302 to
// script.googleusercontent.com. Node's fetch follows that redirect but turns it
// into a GET, which the script rejects — so the redirect is followed by hand and
// the POST body is replayed to the final URL.
const MAX_REDIRECTS = 3;

function isRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function postJson(url, payload, fetchImpl) {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetchImpl(target, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            redirect: "manual",
            signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS)
        });

        if (!isRedirect(response.status)) return response;

        const location = response.headers?.get?.("location");
        if (!location) return response;
        target = new URL(location, target).toString();
    }
    throw new Error("Google email relay redirected too many times");
}

export async function sendEmail({ to, subject, text }, env = process.env, fetchImpl = fetch) {
    const url = env.GOOGLE_APPS_SCRIPT_URL?.trim();
    const secret = env.GOOGLE_APPS_SCRIPT_SECRET?.trim();
    if (!url || !secret) {
        throw new Error("Email delivery is not configured");
    }

    const response = await postJson(url, { secret, to, subject, text }, fetchImpl);

    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`Google email relay returned HTTP ${response.status}`);
    }

    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        // A login/consent page instead of JSON means the deployment is not
        // public or has not been authorized to send mail.
        throw new Error("Google email relay returned an invalid response. Check that the Web App is deployed with access set to Anyone and authorized to send email.");
    }
    if (result?.success !== true) {
        throw new Error(typeof result?.error === "string" ? result.error : "Google email relay could not send the message");
    }
    return result;
}

// Sends a real message so an administrator can confirm the relay end to end.
export async function sendRelayTestEmail(to, env = process.env, fetchImpl = fetch) {
    return sendEmail({
        to,
        subject: "WAMS email relay test",
        text: "This is a test message from WAMS. If you received it, password reset codes can be delivered."
    }, env, fetchImpl);
}
