import { z } from "zod";

export const PipesBotConfigSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  poolNumberId: z.string().optional(),
});
