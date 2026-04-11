// ============================================================================
// System Panel — Tools, skills, and knowledge base browser.
// Shown in the System tab of the right sidebar.
// ============================================================================

interface ToolInfo {
  name: string
  description: string
}

interface SkillInfo {
  name: string
  description: string
  scope: string | string[]
  tools: string[]
}

const renderCollapsibleSection = (
  title: string,
  count: number,
  renderContent: (container: HTMLElement) => void,
): HTMLElement => {
  const section = document.createElement('div')
  section.className = 'border-b border-gray-100'

  const header = document.createElement('div')
  header.className = 'px-3 py-2 text-xs font-medium text-gray-500 cursor-pointer hover:bg-gray-50 flex items-center gap-1'
  const arrow = document.createElement('span')
  arrow.textContent = '▸'
  arrow.className = 'text-gray-400'
  header.appendChild(arrow)
  header.appendChild(document.createTextNode(` ${title} (${count})`))

  const content = document.createElement('div')
  content.className = 'hidden'

  let expanded = false
  header.onclick = () => {
    expanded = !expanded
    content.className = expanded ? 'px-3 pb-2' : 'hidden'
    arrow.textContent = expanded ? '▾' : '▸'
    if (expanded && content.children.length === 0) {
      renderContent(content)
    }
  }

  section.appendChild(header)
  section.appendChild(content)
  return section
}

export const renderSystemPanel = async (container: HTMLElement): Promise<void> => {
  container.innerHTML = ''

  const [tools, skills] = await Promise.all([
    fetch('/api/tools').then(r => r.ok ? r.json() as Promise<ToolInfo[]> : []),
    fetch('/api/skills').then(r => r.ok ? r.json() as Promise<SkillInfo[]> : []),
  ]).catch(() => [[] as ToolInfo[], [] as SkillInfo[]])

  // Tools section
  container.appendChild(renderCollapsibleSection('Tools', tools.length, (el) => {
    for (const tool of tools) {
      const row = document.createElement('div')
      row.className = 'text-xs text-gray-600 py-0.5 hover:bg-gray-50 px-1 rounded cursor-default'
      row.title = tool.description
      row.textContent = tool.name
      el.appendChild(row)
    }
  }))

  // Skills section
  container.appendChild(renderCollapsibleSection('Skills', skills.length, (el) => {
    for (const skill of skills) {
      const row = document.createElement('div')
      row.className = 'text-xs py-1 px-1'
      const name = document.createElement('div')
      name.className = 'font-medium text-gray-700'
      name.textContent = skill.name
      const desc = document.createElement('div')
      desc.className = 'text-gray-400'
      desc.textContent = skill.description
      if (skill.tools.length > 0) {
        desc.textContent += ` · Tools: ${skill.tools.join(', ')}`
      }
      row.appendChild(name)
      row.appendChild(desc)
      el.appendChild(row)
    }
  }))
}
