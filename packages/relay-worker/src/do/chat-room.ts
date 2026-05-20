import type { Env } from '../env';

// Session 1 stub. Full implementation lands in Session 3 (see
// RELAY_BUILD_SPEC.md §8). Required to exist so the wrangler.toml
// migrations and bindings resolve.
export class ChatRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response('ChatRoom not implemented yet (Session 3)', { status: 501 });
  }
}
