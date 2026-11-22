import type { DatabaseSync } from 'node:sqlite'
import { initializeQuickstart } from './quickstart.js'

export function initializeGrowth(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS growth_daily (
    day TEXT NOT NULL, product TEXT NOT NULL, source TEXT NOT NULL, event TEXT NOT NULL,
    mode TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,product,source,event,mode));
    CREATE TABLE IF NOT EXISTS growth_jobs (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    source TEXT NOT NULL, mode TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS growth_job_events (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, event TEXT NOT NULL,
    PRIMARY KEY(job_id,event));`)
  initializeQuickstart(db)
}
