const EMAIL_TIMEOUT_MS = 15_000;

export function isEmailConfigured(env = process.env) {
    return Boolean(env.GOOGLE_APPS_SCRIPT_URL?.trim() && env.GOOGLE_APPS_SCRIPT_SECRET?.trim());
}

export async function sendEmail({ to, subject, text }, env = process.env, fetchImpl = fetch) {
    const url = env.GOOGLE_APPS_SCRIPT_URL?.trim();
    const secret = env.GOOGLE_APPS_SCRIPT_SECRET?.trim();
    if (!url || !secret) {
        throw new Error("Email delivery is not configured");
    }

    const response = await fetchImpl(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ secret, to, subject, text }),
        signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS)
    });

    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`Google email relay returned HTTP ${response.status}`);
    }

    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        throw new Error("Google email relay returned an invalid response");
    }
    if (result?.success !== true) {
        throw new Error(typeof result?.error === "string" ? result.error : "Google email relay could not send the message");
    }
    return result;
}
