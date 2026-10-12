import { NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs'
import { createClient } from '@/utils/supabase/server'
import { createAdminClient } from '@/utils/supabase/admin'
import { getAllProjectMemberIds } from '@/utils/projectMembersStore'
import { getAllProjectDepartmentsMap } from '@/utils/projectDepartmentsStore'
import type { DepartmentKey } from '@/constants/departments'

export const dynamic = 'force-dynamic'

export interface ProjectOption {
  id: string
  name: string
  department: string | null
}

// GET /api/projects/my-projects
// Returns projects accessible to the authenticated user
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'احراز هویت انجام نشده است.' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const returnAll = searchParams.get('all') === 'true'

    let adminClient: any = null
    try {
      adminClient = createAdminClient()
    } catch {
      // adminClient remains null
    }

    const db = adminClient || supabase

    const { data: profile } = await db
      .from('profiles')
      .select('id, role, departments')
      .eq('id', user.id)
      .maybeSingle()

    const role = profile?.role || user.user_metadata?.role || 'member'
    const isAdmin = role === 'admin'

    // Fetch all active projects safely
    let rawProjects: any[] = []
    const { data: projData, error: projErr } = await db
      .from('projects')
      .select('*')
      .order('name', { ascending: true })

    if (!projErr && projData) {
      rawProjects = projData
    } else {
      // Fallback with minimal columns or supabase client
      const { data: fallbackData } = await supabase
        .from('projects')
        .select('id, name')
        .order('name', { ascending: true })
      rawProjects = fallbackData || []
    }

    // Get departments map for projects
    let deptsMap: Record<string, string[]> = {}
    try {
      deptsMap = await getAllProjectDepartmentsMap()
    } catch {
      // ignore
    }

    const allProjects: ProjectOption[] = rawProjects.map((p) => {
      const d = p.department || (deptsMap[p.id] && deptsMap[p.id][0]) || null
      return {
        id: p.id,
        name: p.name,
        department: d,
      }
    })

    if (allProjects.length === 0) {
      return NextResponse.json(
        { projects: [] },
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
      )
    }

    // Admins or explicitly requested ?all=true get all projects
    if (isAdmin || returnAll) {
      return NextResponse.json(
        { projects: allProjects },
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
      )
    }

    // Collect project IDs where user is member/assigned
    const userProjectIds = new Set<string>()

    // 1. Check projects created by user
    for (const p of rawProjects) {
      if (p.created_by === user.id) {
        userProjectIds.add(p.id)
      }
    }

    // 2. Check projectMembersStore (local json, roster tasks, task assignees)
    try {
      const localMap = await getAllProjectMemberIds()
      for (const pid in localMap) {
        if (localMap[pid]?.includes(user.id)) {
          userProjectIds.add(pid)
        }
      }
    } catch {
      // ignore
    }

    // 3. Directly check local data/project_members.json file
    try {
      const localFile = path.join(process.cwd(), 'data', 'project_members.json')
      if (fs.existsSync(localFile)) {
        const raw = fs.readFileSync(localFile, 'utf8')
        const parsed = JSON.parse(raw)
        for (const pid in parsed) {
          if (Array.isArray(parsed[pid]) && parsed[pid].includes(user.id)) {
            userProjectIds.add(pid)
          }
        }
      }
    } catch {
      // ignore
    }

    // 4. Check task_assignees joined query (same approach as /projects page)
    try {
      const { data: assignData } = await supabase
        .from('task_assignees')
        .select('task_id, tasks(project_id)')
        .eq('user_id', user.id)

      if (assignData) {
        for (const item of assignData) {
          const t = item.tasks as unknown as { project_id?: string } | null
          if (t?.project_id) userProjectIds.add(t.project_id)
        }
      }
    } catch {
      // ignore
    }

    // 5. Check task_assignees 2-step query
    try {
      const { data: assignees } = await db
        .from('task_assignees')
        .select('task_id')
        .eq('user_id', user.id)

      if (assignees && assignees.length > 0) {
        const taskIds = assignees.map((a: { task_id: string }) => a.task_id).filter(Boolean)
        const { data: tasks } = await db
          .from('tasks')
          .select('id, project_id')
          .in('id', taskIds)

        if (tasks) {
          for (const t of tasks) {
            if (t.project_id) userProjectIds.add(t.project_id)
          }
        }
      }
    } catch {
      // ignore
    }

    // 6. Check Supabase project_members table
    try {
      const { data: pmData } = await db
        .from('project_members')
        .select('project_id')
        .eq('user_id', user.id)

      if (pmData) {
        for (const row of pmData) {
          if (row.project_id) userProjectIds.add(row.project_id)
        }
      }
    } catch {
      // ignore
    }

    // Also check via user supabase client if db was adminClient
    if (adminClient) {
      try {
        const { data: pmUser } = await supabase
          .from('project_members')
          .select('project_id')
          .eq('user_id', user.id)

        if (pmUser) {
          for (const row of pmUser) {
            if (row.project_id) userProjectIds.add(row.project_id)
          }
        }
      } catch {
        // ignore
      }
    }

    // 7. Check tasks created by user
    try {
      const { data: createdTasks } = await db
        .from('tasks')
        .select('project_id')
        .eq('created_by', user.id)

      if (createdTasks) {
        for (const t of createdTasks) {
          if (t.project_id) userProjectIds.add(t.project_id)
        }
      }
    } catch {
      // ignore
    }

    // Filter projects based on role
    let matchingProjects: ProjectOption[] = []

    if (role === 'mentor') {
      // Mentors can see projects they are assigned to / members of, PLUS projects in their departments
      const mentorDepts = new Set<string>()
      if (profile?.departments && Array.isArray(profile.departments)) {
        for (const d of profile.departments) {
          if (typeof d === 'string') mentorDepts.add(d)
          else if (d?.department) mentorDepts.add(d.department)
        }
      }
      if (user.user_metadata?.departments && Array.isArray(user.user_metadata.departments)) {
        for (const d of user.user_metadata.departments) {
          if (typeof d === 'string') mentorDepts.add(d)
          else if (d?.department) mentorDepts.add(d.department)
        }
      }

      matchingProjects = allProjects.filter((p) => {
        if (userProjectIds.has(p.id)) return true
        const pDeps = deptsMap[p.id] || (p.department ? [p.department] : [])
        if (pDeps.some((d) => mentorDepts.has(d))) return true
        return false
      })
    } else {
      // Regular members: ONLY show projects they belong to
      matchingProjects = allProjects.filter((p) => userProjectIds.has(p.id))
    }

    return NextResponse.json(
      { projects: matchingProjects },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'خطای سرور در دریافت پروژه‌ها'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
