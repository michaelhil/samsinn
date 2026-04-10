// ============================================================================
// Code Generation Tools — Runtime skill and tool authoring by agents.
//
// write_skill: Creates a skill directory with SKILL.md.
// write_tool: Creates a .ts tool file inside a skill's tools/ subdirectory.
// list_skills: Lists all loaded skills with their bundled tools.
// ============================================================================

import type { Tool, ToolRegistry } from '../../core/types.ts'
import type { SkillStore } from '../../skills/loader.ts'
import { VALID_NAME, isTool } from '../loader.ts'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type RefreshAllFn = () => Promise<void>

export const createWriteSkillTool = (
  store: SkillStore,
  skillsDir: string,
): Tool => ({
  name: 'write_skill',
  description: 'Creates a new skill — a behavioral prompt template stored as a SKILL.md file. Skills are injected into agent context to shape how agents approach tasks.',
  usage: 'Use to create reusable behavioral instructions. The body is markdown text describing how agents should approach a category of task. After creating a skill, you can add bundled tools to it with write_tool.',
  returns: 'Object with the skill name and directory path.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name (letters, digits, underscores, hyphens only)' },
      description: { type: 'string', description: 'When this skill should be used' },
      body: { type: 'string', description: 'Markdown body with behavioral instructions' },
      scope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Room names where this skill is active. Omit for global scope.',
      },
    },
    required: ['name', 'description', 'body'],
  },
  execute: async (params) => {
    const name = params.name as string
    const description = params.description as string
    const body = params.body as string
    const scope = params.scope as string[] | undefined

    if (!name || !description || !body) {
      return { success: false, error: 'name, description, and body are required' }
    }

    if (!VALID_NAME.test(name)) {
      return { success: false, error: `Invalid skill name "${name}" — use letters, digits, underscores, hyphens` }
    }

    if (store.get(name)) {
      return { success: false, error: `Skill "${name}" already exists` }
    }

    const dirPath = join(skillsDir, name)
    await mkdir(dirPath, { recursive: true })

    // Build SKILL.md with frontmatter
    const scopeLine = scope && scope.length > 0
      ? `\nscope: [${scope.join(', ')}]`
      : ''
    const content = `---\nname: ${name}\ndescription: ${description}${scopeLine}\n---\n\n${body}\n`

    const filePath = join(dirPath, 'SKILL.md')
    try {
      await writeFile(filePath, content, 'utf-8')
    } catch (err) {
      return { success: false, error: `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}` }
    }

    store.register({
      name,
      description,
      body,
      scope: scope ?? [],
      tools: [],
      dirPath,
    })

    return { success: true, data: { name, path: dirPath } }
  },
})

export const createWriteToolTool = (
  registry: ToolRegistry,
  store: SkillStore,
  refreshAll: RefreshAllFn,
): Tool => ({
  name: 'write_tool',
  description: 'Creates a new executable tool inside a skill directory. The tool is registered immediately and available to all agents.',
  usage: 'Use when you need functionality that no existing tool provides. The tool is bundled with a skill — create the skill first with write_skill if it does not exist. The code parameter is the body of an async function with signature (params, context) => { ... } that must return a ToolResult.',
  returns: 'Object with the registered tool name and file path.',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Name of the skill to bundle this tool with (must exist)' },
      name: { type: 'string', description: 'Tool name (letters, digits, underscores, hyphens only)' },
      description: { type: 'string', description: 'What the tool does' },
      parameters: { type: 'object', description: 'JSON Schema for the tool parameters' },
      code: { type: 'string', description: 'Function body of async (params, context) => { ... }. Must return { success: true, data: ... } or { success: false, error: "..." }' },
    },
    required: ['skill', 'name', 'description', 'parameters', 'code'],
  },
  execute: async (params) => {
    const skillName = params.skill as string
    const name = params.name as string
    const description = params.description as string
    const parameters = params.parameters as Record<string, unknown>
    const code = params.code as string

    if (!skillName || !name || !description || !code) {
      return { success: false, error: 'skill, name, description, and code are required' }
    }

    const skill = store.get(skillName)
    if (!skill) {
      return { success: false, error: `Skill "${skillName}" not found — create it first with write_skill` }
    }

    if (!VALID_NAME.test(name)) {
      return { success: false, error: `Invalid tool name "${name}" — use letters, digits, underscores, hyphens` }
    }

    if (registry.has(name)) {
      return { success: false, error: `Tool "${name}" already exists in registry` }
    }

    const toolsDir = join(skill.dirPath, 'tools')
    await mkdir(toolsDir, { recursive: true })

    const filePath = join(toolsDir, `${name}.ts`)

    const source = `import type { Tool } from '../../../src/core/types.ts'

const tool: Tool = {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)},
  parameters: ${JSON.stringify(parameters, null, 2)},
  execute: async (params: Record<string, unknown>, context) => {
    ${code}
  },
}

export default tool
`

    try {
      await writeFile(filePath, source, 'utf-8')
    } catch (err) {
      return { success: false, error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}` }
    }

    // Dynamic import + validation
    let mod: { default?: unknown }
    try {
      mod = await import(`${filePath}?t=${Date.now()}`)
    } catch (err) {
      await unlink(filePath).catch(() => {})
      return { success: false, error: `Import failed (file deleted): ${err instanceof Error ? err.message : String(err)}` }
    }

    const tool = mod.default
    if (!isTool(tool)) {
      await unlink(filePath).catch(() => {})
      return { success: false, error: 'Generated module does not export a valid Tool. File deleted.' }
    }

    registry.register(tool as Tool)

    // Update skill's tool list
    const updatedSkill = { ...skill, tools: [...skill.tools, name] }
    store.register(updatedSkill)

    try {
      await refreshAll()
    } catch (err) {
      console.error(`[codegen] Failed to refresh agents after registering "${name}":`, err)
    }

    return { success: true, data: { name, skill: skillName, path: filePath } }
  },
})

export const createListSkillsTool = (store: SkillStore): Tool => ({
  name: 'list_skills',
  description: 'Lists all loaded skills with their descriptions, scopes, and bundled tools.',
  returns: 'Array of skill objects with name, description, scope, and tools.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: store.list().map(s => ({
      name: s.name,
      description: s.description,
      scope: s.scope.length > 0 ? s.scope : 'global',
      tools: s.tools,
    })),
  }),
})
