import { afterEach, describe, expect, it, vi } from "vitest";

import type { Repositories } from "@/core/db/repositories/types";

import { seedDefaultEntries } from "../default-entries";

type SkillRow = {
  id: string;
  title: string;
};

type ServerRow = {
  id: string;
  enabled: boolean;
  label: string;
  url: string;
};

function createFakeRepositories(input: {
  skills?: SkillRow[];
  servers?: ServerRow[];
  failSkillCreate?: boolean;
}) {
  const skills = [...(input.skills ?? [])];
  const servers = [...(input.servers ?? [])];

  const repositories = {
    skillRepository: {
      async list() {
        return skills;
      },
      async create(values: { title: string }) {
        if (input.failSkillCreate) {
          throw new Error("disk full");
        }

        const row = { id: `skill-${skills.length + 1}`, title: values.title };
        skills.push(row);
        return row;
      },
    },
    mcpServerRepository: {
      async list() {
        return servers;
      },
      async create(values: { enabled?: boolean; label: string; url: string }) {
        const row = {
          id: `server-${servers.length + 1}`,
          enabled: values.enabled ?? true,
          label: values.label,
          url: values.url,
        };
        servers.push(row);
        return row;
      },
    },
  };

  return { repositories: repositories as unknown as Repositories, servers, skills };
}

const SKILL_MARKDOWN = `---
name: html-video
description: Make videos from HTML canvas scenes.
---

# HTML Video Export
`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("seedDefaultEntries", () => {
  it("installs the default skill and MCP server on an empty database", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(SKILL_MARKDOWN, {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      })),
    );

    const { repositories, servers, skills } = createFakeRepositories({});
    const result = await seedDefaultEntries(repositories);

    expect(result.errors).toEqual([]);
    expect(result.installedSkillIds).toHaveLength(1);
    expect(skills[0]?.title).toBe("html-video");
    expect(result.installedMcpServerIds).toHaveLength(1);
    expect(servers[0]?.label).toBe("Exa");
    // Exa is authMode "none", so it must be enabled so it works immediately.
    expect(servers[0]?.enabled).toBe(true);
    expect(servers[0]).toMatchObject({ url: "https://mcp.exa.ai/mcp" });
  });

  it("is idempotent when everything is already installed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(SKILL_MARKDOWN, {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      })),
    );

    const first = createFakeRepositories({});
    const firstResult = await seedDefaultEntries(first.repositories);
    expect(firstResult.errors).toEqual([]);

    // Simulate a fresh launch over the same database state.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network should not be used");
      }),
    );

    const second = createFakeRepositories({
      servers: first.servers,
      skills: first.skills,
    });
    const secondResult = await seedDefaultEntries(second.repositories);

    expect(secondResult.errors).toEqual([]);
    expect(secondResult.installedSkillIds).toEqual([]);
    expect(secondResult.installedMcpServerIds).toEqual([]);
  });

  it("skips a skill when only the parsed title matches an existing skill", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(SKILL_MARKDOWN, {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      })),
    );

    // Existing skill was stored under the frontmatter title, not the catalog
    // label; seeding must not create a duplicate.
    const { repositories, skills } = createFakeRepositories({
      skills: [{ id: "existing", title: "html-video" }],
    });
    const result = await seedDefaultEntries(repositories);

    expect(result.installedSkillIds).toEqual([]);
    expect(skills).toHaveLength(1);
  });

  it("reports an error and continues when a skill download fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("SKILL.md")) {
          return new Response("boom", { status: 500 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const { repositories, servers, skills } = createFakeRepositories({});
    const result = await seedDefaultEntries(repositories);

    expect(result.installedSkillIds).toEqual([]);
    expect(skills).toHaveLength(0);
    expect(result.errors.some((message) => message.includes("html-video"))).toBe(
      true,
    );
    // The MCP server still seeds even though the skill failed.
    expect(result.installedMcpServerIds).toHaveLength(1);
    expect(servers).toHaveLength(1);
  });

  it("reports an error when the skill cannot be persisted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(SKILL_MARKDOWN, {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      })),
    );

    const { repositories } = createFakeRepositories({ failSkillCreate: true });
    const result = await seedDefaultEntries(repositories);

    expect(result.installedSkillIds).toEqual([]);
    expect(result.errors.some((message) => message.includes("html-video"))).toBe(
      true,
    );
  });

  it("does not seed the default MCP server when the same URL and label exist", async () => {
    const { repositories } = createFakeRepositories({
      servers: [
        {
          id: "user-added",
          enabled: true,
          label: "Exa",
          url: "https://mcp.exa.ai/mcp",
        },
      ],
    });
    const result = await seedDefaultEntries(repositories);

    expect(result.installedMcpServerIds).toEqual([]);
  });
});
