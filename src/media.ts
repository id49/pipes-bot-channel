import { getPipesBotRuntime } from "./runtime.js";
import type { PluginLogger } from "./types.js";

const PIPES_BOT_API_BASE = "https://api.pipes.bot";

export async function downloadPipesBotMedia(params: {
  downloadUrl: string;
  mimeType: string;
  fileName?: string;
  apiKey: string;
  logger: PluginLogger;
}): Promise<{ path: string; contentType: string } | null> {
  const core = getPipesBotRuntime();
  const absoluteUrl = `${PIPES_BOT_API_BASE}${params.downloadUrl}`;

  try {
    // First request with auth — follow redirects manually so the
    // Authorization header is NOT forwarded to the R2 pre-signed URL.
    const initialResponse = await fetch(absoluteUrl, {
      headers: { Authorization: `Bearer ${params.apiKey}` },
      redirect: "manual",
    });

    const redirectUrl =
      initialResponse.status >= 300 && initialResponse.status < 400
        ? initialResponse.headers.get("location")
        : null;

    const fetched = await core.channel.media.fetchRemoteMedia({
      url: redirectUrl ?? absoluteUrl,
      fetchImpl: redirectUrl
        ? undefined // no custom headers needed for pre-signed R2 URL
        : (input, init) => {
            const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
            headers.set("Authorization", `Bearer ${params.apiKey}`);
            return fetch(input, { ...init, headers });
          },
      filePathHint: params.fileName,
    });

    const saved = await core.channel.media.saveMediaBuffer(
      fetched.buffer,
      fetched.contentType ?? params.mimeType,
      "inbound",
    );

    return {
      path: saved.path,
      contentType: saved.contentType ?? params.mimeType,
    };
  } catch (err) {
    params.logger.error(
      `pipes-bot-channel: media download failed for ${params.downloadUrl}: ${String(err)}`,
    );
    return null;
  }
}
