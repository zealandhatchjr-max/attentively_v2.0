import type { BoardItem, BoardProvider } from "./types.js";

/**
 * Kolaboreyt (the team's monday.com-style board tool) adapter.
 *
 * WAITING ON API DOCS: the method bodies below are placeholders until the
 * Kolaboreyt API key and integration instructions arrive. Until then run with
 * BOARD_PROVIDER=local, which serves the same board from Attentively.
 *
 * Needed from the API: create a board per run in Attentively's workspace, custom
 * columns, upsert items, a per-run share link (view, answer, Resolve), and a
 * webhook or poll for the Resolved status.
 */
export class KolaboreytBoard implements BoardProvider {
  name = "kolaboreyt";
  constructor(
    private apiKey: string,
    private baseUrl: string,
  ) {}

  private notYet(): never {
    throw new Error("Kolaboreyt adapter not implemented yet: waiting on API docs. Use BOARD_PROVIDER=local.");
  }

  async createBoard(_input: { runId: string; title: string; header: Record<string, string>; columns: string[] }): Promise<{
    boardId: string;
    shareUrl: string;
  }> {
    void this.apiKey;
    void this.baseUrl;
    this.notYet();
  }
  async upsertItem(_boardId: string, _item: BoardItem): Promise<void> {
    this.notYet();
  }
  async updateHeader(_boardId: string, _header: Record<string, string>): Promise<void> {
    this.notYet();
  }
}
