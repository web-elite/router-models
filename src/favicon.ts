// ------------------------------------------------------------------
// Automatic favicon discovery for a provider's base URL.
// ------------------------------------------------------------------

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
//'Mozilla/5.0 (compatible; RouterModels/0.3; ' + '+https://github.com/web-elite/router-models)';

const MAX_HTML_BYTES = 300_000;

function iconHrefFromLinks(
    html: string,
    wantedRels: string[]
): string | undefined {
    const tags = html.match(/<link\b[^>]*>/gi) ?? [];

    for (const wanted of wantedRels) {
        for (const tag of tags) {
            const rel = (
                tag.match(/\brel\s*=\s*["']([^"']*)["']/i)?.[1] ?? ''
            )
                .toLowerCase()
                .split(/\s+/);

            if (!rel.includes(wanted)) {
                continue;
            }

            const href = tag.match(
                /\bhref\s*=\s*["']([^"']*)["']/i
            )?.[1];

            if (href) {
                return href;
            }
        }
    }

    return undefined;
}

/**
 * Resolves a favicon URL for the site behind `baseUrl`:
 *
 * 1. `<link rel="icon">` / `shortcut icon` declared in the page,
 * 2. `apple-touch-icon`,
 * 3. the conventional `/favicon.ico` (validated later by the download).
 */
export async function discoverFavicon(
    baseUrl: string,
    timeoutMs = 8000
): Promise<string | undefined> {
    let origin: URL;

    try {
        origin = new URL(baseUrl);
    } catch {
        return undefined;
    }

    const root = `${origin.protocol}//${origin.host}`;

    // When the host is a subdomain (e.g. `api.site.com`), strip it and
    // resolve the favicon from the main domain (`site.com`).
    const mainHost = origin.hostname.split('.').slice(-2).join('.');
    const mainRoot = `${origin.protocol}//${mainHost}`;
    const faviconRoot =
        mainHost === origin.hostname ? root : mainRoot;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        try {
            const response = await fetch(faviconRoot + '/', {
                signal: controller.signal,
                headers: { 'user-agent': USER_AGENT }
            });

            if (response.ok) {
                const html = (await response.text()).slice(
                    0,
                    MAX_HTML_BYTES
                );

                const candidates = [
                    iconHrefFromLinks(html, [
                        'icon',
                        'shortcut icon'
                    ]),
                    iconHrefFromLinks(html, ['apple-touch-icon'])
                ];

                for (const candidate of candidates) {
                    if (!candidate || /^data:/i.test(candidate)) {
                        continue;
                    }

                    try {
                        return new URL(candidate, root).toString();
                    } catch {
                        // Malformed href; try the next candidate.
                    }
                }
            }
        } catch {
            // Site unreachable / blocked — fall through to favicon.ico.
        }

        return `${root}/favicon.ico`;
    } finally {
        clearTimeout(timer);
    }
}
