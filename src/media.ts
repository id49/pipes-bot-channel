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
    const fetched = await core.channel.media.fetchRemoteMedia({
      url: absoluteUrl,
      fetchImpl: (input, init) => {
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
