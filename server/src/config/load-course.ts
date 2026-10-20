// Boot-time loading of the event's GPX course (Story 3.3). `coursePath` is
// resolved relative to the directory of event.json; an absolute path is kept.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildCourse } from '../domain/course.ts';
import type { Course } from '../domain/course.ts';
import { parseGpx } from '../domain/gpx.ts';
import { ConfigError } from './load-config.ts';

export type { Course };

/** The resolved GPX path: relative to dirname(configPath), or as is when absolute. */
export function resolveCoursePath(configPath: string, coursePath: string): string {
  return resolve(dirname(configPath), coursePath);
}

/** Reads, parses and builds the course. Every failure is a ConfigError naming the resolved GPX path. */
export function loadCourse(configPath: string, coursePath: string): Course {
  const path = resolveCoursePath(configPath, coursePath);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read course GPX at ${path}: ${(err as Error).message}`);
  }
  try {
    return buildCourse(parseGpx(text));
  } catch (err) {
    throw new ConfigError(`Invalid course GPX at ${path}: ${(err as Error).message}`);
  }
}
