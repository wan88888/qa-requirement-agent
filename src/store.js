import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, hash } from './review.js';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'reviews.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS qa_entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL)');
  }
  hasRecords() {
    return Boolean(this.db.prepare('SELECT EXISTS(SELECT 1 FROM reviews) OR EXISTS(SELECT 1 FROM qa_entities) AS present').get().present);
  }
  listEntities(kind) { return this.db.prepare('SELECT body FROM qa_entities WHERE kind = ? ORDER BY rowid DESC').all(kind).map(r => JSON.parse(r.body)); }
  entity(id) { const row = this.db.prepare('SELECT body FROM qa_entities WHERE id = ?').get(id); if (!row) throw new AppError('执行计划不存在。', 404); return JSON.parse(row.body); }
  saveEntity(value) { this.db.prepare('INSERT INTO qa_entities (id, kind, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id, value.kind, JSON.stringify(value)); return value; }
  list() { return this.db.prepare('SELECT body FROM reviews ORDER BY rowid DESC').all().map(r => JSON.parse(r.body)); }
  get(id) {
    const row = this.db.prepare('SELECT body FROM reviews WHERE id = ?').get(id);
    if (!row) throw new AppError('未找到该评审任务。', 404, 'NOT_FOUND');
    return JSON.parse(row.body);
  }
  create(input, requestKey) {
    const requestHash = hash(JSON.stringify(input));
    const old = this.db.prepare('SELECT body, request_hash FROM reviews WHERE request_key = ?').get(requestKey);
    if (old) {
      if (old.request_hash !== requestHash) throw new AppError('重复请求标识对应了不同内容，请重新提交。', 409, 'IDEMPOTENCY_CONFLICT');
      return { task: JSON.parse(old.body), existing: true };
    }
    const now = new Date().toISOString();
    const task = { id: randomUUID(), kind: input.kind || 'review', options: input.kind ? input : undefined, mode: input.mode, title: input.title || '新的需求评审', sourceType: input.sourceType, status: 'queued', stage: '等待处理', createdAt: now, updatedAt: now, events: [{ time: now, text: '任务已创建' }], source: null, report: null, publish: { status: 'idle', url: null }, error: null };
    this.db.prepare('INSERT INTO reviews VALUES (?, ?, ?, ?)').run(task.id, requestKey, requestHash, JSON.stringify(task));
    return { task, existing: false };
  }
  save(task) { task.updatedAt = new Date().toISOString(); this.db.prepare('UPDATE reviews SET body = ? WHERE id = ?').run(JSON.stringify(task), task.id); return task; }
  change(id, fn) { const task = this.get(id); fn(task); return this.save(task); }
  stage(id, status, text) { return this.change(id, task => { task.status = status; task.stage = text; task.events.push({ time: new Date().toISOString(), text }); }); }
  recover() {
    for (const task of this.list()) {
      for (const call of task.usage?.calls || []) if (call.status === 'started') { call.status = 'interrupted'; call.errorCode = 'SERVICE_RESTARTED'; }
      if (task.publish.status === 'creating') { task.publish.status = 'uncertain'; task.publish.error = '创建期间服务中断，结果未知。请先到飞书核实，系统不会自动重复创建。'; }
      if (task.publish.status === 'verifying') { task.publish.status = 'verify_failed'; task.publish.error = '回读期间服务中断，可重新校验已有报告。'; }
      if (!['completed', 'failed'].includes(task.status)) { task.status = task.report ? 'completed' : 'failed'; task.stage = '上次任务因服务重启中断'; task.error = task.report ? null : '服务重启导致任务中断，请重新发起评审。'; }
      this.save(task);
    }
  }
  close() { this.db.close(); }
}
