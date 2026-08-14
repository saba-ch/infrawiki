// The ChatGPT Codex backend (chatgpt.com/backend-api/codex) rejects requests
// unless `store` is false AND `stream` is true. This fetch wrapper forces
// both; when the caller sent a non-streaming request (generateText), it
// consumes the SSE stream and hands back the final response as plain JSON so
// @ai-sdk/openai's non-streaming parser still works.

export function codexOAuthFetch(
  baseFetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    let wantsStream = true;
    let body = init?.body;
    if (typeof body === "string") {
      const parsed = JSON.parse(body);
      wantsStream = parsed.stream === true;
      parsed.store = false;
      parsed.stream = true;
      // The backend rejects this parameter outright.
      delete parsed.max_output_tokens;
      body = JSON.stringify(parsed);
    }
    const headers = new Headers(init?.headers);
    if (!headers.has("session_id"))
      headers.set("session_id", crypto.randomUUID());

    const response = await baseFetch(input, { ...init, headers, body });
    if (wantsStream || !response.ok) return response;

    const text = await response.text();
    // The final response object arrives with an empty `output` (store is
    // false), so collect the completed output items from the stream events
    // and patch them in for the non-streaming parser.
    const items: unknown[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let event: {
        type?: string;
        item?: unknown;
        response?: { output?: unknown[] };
      };
      try {
        event = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (event.type === "response.output_item.done") items.push(event.item);
      if (
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed"
      ) {
        return new Response(
          JSON.stringify({ ...event.response, output: items }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    return new Response(
      JSON.stringify({
        error: { message: "Codex stream ended without a completed response" },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  };
}
