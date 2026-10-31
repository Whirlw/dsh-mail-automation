/** 测试用：冒充宿主模块（DSH 进程里的 @deepseek-ai/* 真实实现） */
import { randomUUID } from 'node:crypto';

export function defineTool(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('defineTool 需要对象');
  return definition;
}

export function createUserMessage({ content, source }) {
  return { id: randomUUID(), role: 'user', content, source };
}

export const SessionSeq = (value) => value;
export const SessionId = (value) => value;
export const brandString = (value) => value;
