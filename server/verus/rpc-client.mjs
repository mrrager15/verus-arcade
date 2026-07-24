export class VerusRpcError extends Error {
  constructor(message, { code, method, submissionUncertain = false, cause } = {}) {
    super(message, { cause });
    this.name = 'VerusRpcError';
    this.code = code;
    this.method = method;
    this.submissionUncertain = submissionUncertain;
  }
}

export class VerusRpcClient {
  constructor({
    url,
    username,
    password,
    timeoutMilliseconds = 15_000,
    fetchImpl = fetch,
  }) {
    if (!url || !username || !password) {
      throw new Error('RPC URL, username, and password are required');
    }
    this.url = url;
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.fetchImpl = fetchImpl;
  }

  async call(method, params = []) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          authorization: this.authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '1.0',
          id: `arcade-${method}`,
          method,
          params,
        }),
        signal: controller.signal,
      });
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new VerusRpcError('RPC returned invalid JSON', {
          code: 'RPC_INVALID_JSON',
          method,
          submissionUncertain: method === 'sendrawtransaction',
          cause: error,
        });
      }
      if (body.error) {
        throw new VerusRpcError(`RPC ${method} failed: ${body.error.message}`, {
          code: body.error.code,
          method,
        });
      }
      if (!response.ok) {
        throw new VerusRpcError(`RPC ${method} returned HTTP ${response.status}`, {
          code: `HTTP_${response.status}`,
          method,
          submissionUncertain: method === 'sendrawtransaction',
        });
      }
      return body.result;
    } catch (error) {
      if (error instanceof VerusRpcError) throw error;
      const timedOut = error?.name === 'AbortError';
      throw new VerusRpcError(
        timedOut
          ? `RPC ${method} timed out`
          : `RPC ${method} connection failed`,
        {
          code: timedOut ? 'RPC_TIMEOUT' : 'RPC_CONNECTION_FAILED',
          method,
          submissionUncertain: method === 'sendrawtransaction',
          cause: error,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
