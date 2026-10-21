import * as Crypto from "expo-crypto";
import { eq, sql } from "drizzle-orm";

import { pendingInputs } from "@/core/db/schema";
import { nowIso } from "@/core/db/repositories/shared";
import type { AppDatabase, PendingInputRepository } from "@/core/db/repositories/types";

async function getNextSequence(db: AppDatabase, conversationId: string) {
  const row = (
    await db
      .select({
        nextSequence: sql<number>`coalesce(max(${pendingInputs.seq}), 0) + 1`,
      })
      .from(pendingInputs)
      .where(eq(pendingInputs.conversationId, conversationId))
      .limit(1)
  )[0];

  return row?.nextSequence ?? 1;
}

export function createPendingInputRepository(
  db: AppDatabase,
): PendingInputRepository {
  return {
    async create(input) {
      const id = input.id ?? Crypto.randomUUID();
      const timestamp = nowIso();
      const seq = await getNextSequence(db, input.conversationId);

      await db.insert(pendingInputs).values({
        id,
        conversationId: input.conversationId,
        content: input.content,
        metadata: input.metadata ?? null,
        delivery: input.delivery,
        seq,
        createdAt: timestamp,
      });

      const row = (
        await db.select().from(pendingInputs).where(eq(pendingInputs.id, id)).limit(1)
      )[0];

      if (!row) {
        throw new Error("Failed to create pending input");
      }

      return row;
    },
    async listByConversation(conversationId) {
      return db
        .select()
        .from(pendingInputs)
        .where(eq(pendingInputs.conversationId, conversationId))
        .orderBy(pendingInputs.seq);
    },
    async listAll() {
      return db.select().from(pendingInputs).orderBy(pendingInputs.createdAt);
    },
    async delete(id) {
      await db.delete(pendingInputs).where(eq(pendingInputs.id, id));
    },
    async deleteByConversation(conversationId) {
      await db
        .delete(pendingInputs)
        .where(eq(pendingInputs.conversationId, conversationId));
    },
  };
}
