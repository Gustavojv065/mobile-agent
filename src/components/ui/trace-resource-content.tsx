import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSQLiteContext } from "expo-sqlite";

import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { createDrizzleDb } from "@/core/db/repositories/shared";
import { createWorkspaceRepository } from "@/core/db/repositories/workspace-repository";
import { createWorkspaceFileService, isDocumentWorkspaceFile, isTextWorkspaceFile } from "@/core/services/workspace-file-service";
import type { ToolExecutionRecord, WorkspaceFile } from "@/core/types/app-state";
import { useChat } from "@/hooks/use-chat";
import { readToolResourceReference } from "@/modules/chat/tool-resource";
import { skillSlugMatches } from "@/modules/skills/skill-markdown";

const LIMIT = 20000;

/** Lazy fallback for old turns: open the real resource, never invent a historic snapshot. */
export function TraceResourceContent({ record }: { record: ToolExecutionRecord }) {
  const db = useSQLiteContext();
  const { skills, workspaceFiles } = useChat();
  const repository = useMemo(() => createWorkspaceRepository(createDrizzleDb(db)), [db]);
  const service = useMemo(() => createWorkspaceFileService(repository), [repository]);
  const reference = useMemo(() => readToolResourceReference(record), [record]);
  const skill = reference.skillName
    ? skills.find((item) => skillSlugMatches(item, reference.skillName!))
    : undefined;
  const skillText = record.toolName === "skill"
    ? skill?.instructions
    : record.toolName === "skillReadFile"
      ? skill?.skillFiles.find((item) => item.path === reference.path)?.content
      : undefined;
  const knownFile = workspaceFiles.find((item) => reference.fileId
    ? item.id === reference.fileId
    : Boolean(reference.displayName) && item.displayName === reference.displayName);
  const [result, setResult] = useState<{ file?: WorkspaceFile; text?: string; truncated?: boolean; error?: string }>();

  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    if (record.toolName === "skill" || record.toolName === "skillReadFile") return;
    void (async () => {
      const file = knownFile ?? (reference.fileId ? await repository.getById(reference.fileId) : null);
      if (!file) throw new Error("This file is no longer available.");
      const readable = isTextWorkspaceFile(file) || isDocumentWorkspaceFile(file);
      // Do not allocate huge originals simply to expand a trace row.
      const content = file.sourceMarkdown ?? (readable && (file.size ?? 0) <= 1_000_000
        ? await service.readWorkspaceFileText(file) : undefined);
      if (!cancelled) setResult({ file, text: content?.slice(0, LIMIT), truncated: content !== undefined && content.length > LIMIT });
    })().catch((error: unknown) => {
      if (!cancelled) setResult({ error: error instanceof Error ? error.message : "Unable to open this file." });
    });
    return () => { cancelled = true; };
  }, [knownFile, reference.fileId, repository, service, record.toolName]);

  const isSkill = record.toolName === "skill" || record.toolName === "skillReadFile";
  const text = isSkill ? skillText?.slice(0, LIMIT) : result?.text;
  const truncated = isSkill ? (skillText?.length ?? 0) > LIMIT : result?.truncated;

  if (text === undefined) {
    return (
      <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
        {isSkill ? "This skill is no longer available." : result?.error ?? (result?.file ? "" : "Loading file…")}
      </Text>
    );
  }

  return (
    <View className="gap-sp-2">
      <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
        <CodeBlock size="sm"><CodeBlockContent wrap>{text || "(Empty file)"}</CodeBlockContent></CodeBlock>
      </ScrollView>
      {truncated ? <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">Showing the first {LIMIT.toLocaleString()} characters.</Text> : null}
    </View>
  );
}
