const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const EMAIL_TIMEOUT_MS = 15_000;

export function isEmailConfigured(env = process.env) {
    return Boolean(env.RESEND_API_KEY?.trim() && env.RESEND_FROM?.trim());
}

export async function sendEmail({ to, subject, text }, env = process.env, fetchImpl = fetch) {
    const apiKey = env.RESEND_API_KEY?.trim();
    const from = env.RESEND_FROM?.trim();
    if (!apiKey || !from) {
        throw new Error("Email delivery is not configured");
    }

    const response = await fetchImpl(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ from, to, subject, text }),
        signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS)
    });

    if (!response.ok) {
        const responseBody = await response.text();
        let detail = "";
        try {
            const parsed = JSON.parse(responseBody);
            detail = typeof parsed.message === "string" ? parsed.message : "";
        } catch {
            detail = "";
        }
        throw new Error(detail || `Email provider returned HTTP ${response.status}`);
    }

    return response.json();
}
