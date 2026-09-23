let token: string | null = null;
let initializing: Promise<void> | null = null;

async function connect(): Promise<void> {
  if (token) return;
  if (!initializing)
    initializing = fetch('/api/bootstrap')
      .then(async (response) => {
        if (!response.ok) throw new Error('无法连接本地服务。');
        const data = await response.json();
        if (typeof data.token !== 'string') throw new Error('本地服务返回了无效会话。');
        token = data.token;
      })
      .finally(() => {
        initializing = null;
      });
  return initializing;
}

export async function api<T>(
  url: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  await connect();
  const response = await fetch(url, {
    method: options?.method ?? 'GET',
    signal: options?.signal,
    headers: { 'Content-Type': 'application/json', 'X-Review-Token': token! },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败 (${response.status})`);
  return result as T;
}
