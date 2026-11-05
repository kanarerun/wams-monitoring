const EMAIL_TIMEOUT_MS = 15_000;

export function isEmailConfigured(env = process.env) {
    return Boolean(env.GOOGLE_APPS_SCRIPT_URL?.trim() && env.GOOGLE_APPS_SCRIPT_SECRET?.trim());
}

// Google Apps Script Web Apps answer a POST with a 302 to
// script.googleusercontent.com, and that redirect target only accepts GET
// (`allow: HEAD, GET`). Replaying the POST there returns 405, so the redirect is
// followed with a GET — the same thing curl does with -L and no -X POST.
const MAX_REDIRECTS = 3;

function isRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function postJson(url, payload, fetchImpl) {
    let target = url;
    let method = "POST";
    let body = JSON.stringify(payload);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetchImpl(target, {
            method,
            headers: {
                "Content-Type": "application/json"
            },
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS)
        });

        if (!isRedirect(response.status)) return response;

        const location = response.headers?.get?.("location");
        if (!location) return response;
        target = new URL(location, target).toString();
        // The redirect target only serves GET, so drop the body from here on.
        method = "GET";
        body = undefined;
    }
    throw new Error("Google email relay redirected too many times");
}

// A 405 from the relay means the request reached Google but the method was not
// accepted. The usual causes are a /dev URL (only /exec accepts POST) or a
// deployment that is not a Web App.
function describeRelayStatus(status) {
    if (status === 405) {
        return `Google email relay returned HTTP 405 (method not allowed). Check that GOOGLE_APPS_SCRIPT_URL is the /exec URL of a deployed Web App, not /dev or a library URL.`;
    }
    if (status === 404) {
        return `Google email relay returned HTTP 404. The deployment URL is stale or was deleted; redeploy the Web App and use the new /exec URL.`;
    }
    if (status === 401 || status === 403) {
        return `Google email relay returned HTTP ${status}. The Web App is not accessible to anyone; set "Who has access" to Anyone and authorize it.`;
    }
    return `Google email relay returned HTTP ${status}`;
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
        throw new Error(describeRelayStatus(response.status));
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
