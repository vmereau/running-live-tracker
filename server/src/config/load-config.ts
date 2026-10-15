// Boot-time loading and validation of config/event.json (AD-5, AD-12).
// The config is read once at boot and is read-only at runtime.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected a lowercase slug (a-z, 0-9, single dashes)');
const epochMs = z.number().int().nonnegative();

export const RunnerConfig = z.object({
  runnerId: slug,
  displayName: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb color'),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex chars (SHA-256)'),
});
export type RunnerConfig = z.infer<typeof RunnerConfig>;

export const EventConfig = z
  .object({
    eventId: slug,
    name: z.string().min(1),
    opensAt: epochMs,
    closesAt: epochMs,
    coursePath: z.string().min(1).optional(),
    runners: z.array(RunnerConfig).min(1),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.opensAt >= cfg.closesAt) {
      ctx.addIssue({ code: 'custom', path: ['closesAt'], message: 'closesAt must be after opensAt' });
    }
    for (const field of ['runnerId', 'keyHash'] as const) {
      const firstIndex = new Map<string, number>();
      cfg.runners.forEach((runner, i) => {
        const value = runner[field];
        const first = firstIndex.get(value);
        if (first === undefined) firstIndex.set(value, i);
        else
          ctx.addIssue({
            code: 'custom',
            path: ['runners', i, field],
            message: `duplicate ${field} (same as runners.${first}.${field})`,
          });
      });
    }
  });
export type EventConfig = z.infer<typeof EventConfig>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads and validates the event config. Throws ConfigError naming the file and every failing field path. */
export function loadConfig(path: string): EventConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read event config at ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    // Windows PowerShell 5.1 writes UTF-8 with a BOM, which JSON.parse rejects.
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new ConfigError(`Event config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = EventConfig.safeParse(json);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(`Invalid event config at ${path}:\n${lines.join('\n')}`);
  }
  return result.data;
}
