import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1).max(64).trim(),
  password: z.string().min(1).max(256),
  totp:     z.string().length(6).regex(/^\d{6}$/),
});

export const playerQuerySchema = z.object({
  page:   z.coerce.number().int().min(0).default(0),
  search: z.string().max(256).optional(),
});

export const revokeSchema = z.object({
  playerId: z.string().uuid(),
  reason:   z.string().max(500).optional(),
});

export const creditSchema = z.object({
  playerId: z.string().uuid(),
  delta:    z.number().int().min(-100_000).max(100_000),
  reason:   z.string().max(500).optional(),
});

export const configSetSchema = z.object({
  key:         z.string().min(1).max(128).regex(/^[a-z0-9_.]+$/),
  value:       z.string().max(4096),
  description: z.string().max(256).optional(),
});

export type LoginInput     = z.infer<typeof loginSchema>;
export type PlayerQuery    = z.infer<typeof playerQuerySchema>;
export type RevokeInput    = z.infer<typeof revokeSchema>;
export type CreditInput    = z.infer<typeof creditSchema>;
export type ConfigSetInput = z.infer<typeof configSetSchema>;