// User-created device groups ("study devices", "bedroom devices").
//
// Type-derived groups such as "phones" or "computers" are NOT rows here — the
// resolver derives those from device_type so they cannot drift out of sync
// with the registry. See src/devices/resolver.ts.

import type { Database as DbType } from 'better-sqlite3';
import { ids } from '../../util/ids.js';
import { now } from '../../util/time.js';

interface GroupRow {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  created_at: number;
  updated_at: number;
}

export interface DeviceGroup {
  id: string;
  userId: string;
  name: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
}

const rowToGroup = (r: GroupRow): DeviceGroup => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  slug: r.slug,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** "Study Devices" -> "study-devices". Also used to match spoken group names. */
export function slugifyGroup(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createDeviceGroupRepo(db: DbType) {
  const insertStmt = db.prepare(`
    INSERT INTO device_groups (id, user_id, name, slug, created_at, updated_at)
    VALUES (@id, @user_id, @name, @slug, @created_at, @updated_at)
  `);
  const byIdStmt = db.prepare<[string]>('SELECT * FROM device_groups WHERE id = ?');
  const bySlugStmt = db.prepare<[string, string]>(
    'SELECT * FROM device_groups WHERE user_id = ? AND slug = ?',
  );
  const listStmt = db.prepare<[string]>(
    'SELECT * FROM device_groups WHERE user_id = ? ORDER BY name ASC',
  );
  const renameStmt = db.prepare<[string, string, number, string]>(
    'UPDATE device_groups SET name = ?, slug = ?, updated_at = ? WHERE id = ?',
  );
  const deleteStmt = db.prepare<[string]>('DELETE FROM device_groups WHERE id = ?');

  const addMemberStmt = db.prepare<[string, string]>(
    'INSERT OR IGNORE INTO device_group_members (group_id, device_id) VALUES (?, ?)',
  );
  const removeMemberStmt = db.prepare<[string, string]>(
    'DELETE FROM device_group_members WHERE group_id = ? AND device_id = ?',
  );
  const clearMembersStmt = db.prepare<[string]>(
    'DELETE FROM device_group_members WHERE group_id = ?',
  );
  const memberIdsStmt = db.prepare<[string]>(
    'SELECT device_id FROM device_group_members WHERE group_id = ?',
  );
  const groupsForDeviceStmt = db.prepare<[string]>(
    `SELECT g.* FROM device_groups g
       JOIN device_group_members m ON m.group_id = g.id
      WHERE m.device_id = ? ORDER BY g.name ASC`,
  );

  return {
    create(input: { userId: string; name: string; deviceIds?: string[] }): DeviceGroup {
      const ts = now();
      const row: GroupRow = {
        id: ids.group(),
        user_id: input.userId,
        name: input.name,
        slug: slugifyGroup(input.name),
        created_at: ts,
        updated_at: ts,
      };
      const tx = db.transaction(() => {
        insertStmt.run(row);
        for (const d of input.deviceIds ?? []) addMemberStmt.run(row.id, d);
      });
      tx();
      return rowToGroup(row);
    },

    getById(id: string): DeviceGroup | null {
      const row = byIdStmt.get(id) as GroupRow | undefined;
      return row ? rowToGroup(row) : null;
    },

    getOwned(userId: string, id: string): DeviceGroup | null {
      const row = byIdStmt.get(id) as GroupRow | undefined;
      if (!row || row.user_id !== userId) return null;
      return rowToGroup(row);
    },

    getBySlug(userId: string, slug: string): DeviceGroup | null {
      const row = bySlugStmt.get(userId, slug) as GroupRow | undefined;
      return row ? rowToGroup(row) : null;
    },

    listByUser(userId: string): DeviceGroup[] {
      return (listStmt.all(userId) as GroupRow[]).map(rowToGroup);
    },

    rename(id: string, name: string): void {
      renameStmt.run(name, slugifyGroup(name), now(), id);
    },

    remove(id: string): void {
      deleteStmt.run(id);
    },

    addMember(groupId: string, deviceId: string): void {
      addMemberStmt.run(groupId, deviceId);
    },

    removeMember(groupId: string, deviceId: string): void {
      removeMemberStmt.run(groupId, deviceId);
    },

    setMembers(groupId: string, deviceIds: string[]): void {
      const tx = db.transaction(() => {
        clearMembersStmt.run(groupId);
        for (const d of deviceIds) addMemberStmt.run(groupId, d);
      });
      tx();
    },

    memberDeviceIds(groupId: string): string[] {
      return (memberIdsStmt.all(groupId) as { device_id: string }[]).map((r) => r.device_id);
    },

    groupsForDevice(deviceId: string): DeviceGroup[] {
      return (groupsForDeviceStmt.all(deviceId) as GroupRow[]).map(rowToGroup);
    },
  };
}

export type DeviceGroupRepo = ReturnType<typeof createDeviceGroupRepo>;
