/** 测试用 ESM loader：把宿主提供的模块映射到本地桩 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const HOST_STUB = pathToFileURL(path.join(HERE, 'host-stub.mjs')).href;

const STUBS = {
  '@deepseek-ai/dsh-tools': HOST_STUB,
  '@deepseek-ai/dsh-llm': HOST_STUB,
  '@deepseek-ai/dsh-session': HOST_STUB,
  '@deepseek-ai/dsh-brand': HOST_STUB,
};

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) return { url: stub, shortCircuit: true };
  return nextResolve(specifier, context);
}
