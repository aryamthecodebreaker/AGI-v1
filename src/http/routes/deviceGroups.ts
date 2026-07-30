// Device group routes.
//
// Only user-created groups are stored. Type-derived groups ("phones",
// "computers", "all") are computed by the resolver and listed here as read-only
// so the UI can show everything the user is allowed to say.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeviceStorage } from '../../storage/index.js';
import { requireAuth } from '../../auth/middleware.js';
import type { AgiCommand } from '../../devices/index.js';
import { requireFeature } from './agiCommand.js';
import { Errors } from '../../util/errors.js';
import { isVirtualGroup } from '../../devices/resolver.js';
import { slugifyGroup } from '../../storage/repositories/deviceGroupRepo.js';

const createSchema = z.object({
  name: z.string().min(1).max(60),
  deviceIds: z.array(z.string().max(64)).max(100).default([]),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    deviceIds: z.array(z.string().max(64)).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

export async function deviceGroupRoutes(
  app: FastifyInstance,
  storage: DeviceStorage,
  agi: AgiCommand,
): Promise<void> {
  const auth = requireAuth(storage);
  const feature = requireFeature(agi);

  /** Every device id must belong to the caller — never trust the body. */
  function assertOwnedDevices(userId: string, deviceIds: string[]): void {
    for (const id of deviceIds) {
      if (!storage.devices.getOwned(userId, id)) {
        throw Errors.badRequest(`Unknown device: ${id}`);
      }
    }
  }

  app.get('/api/device-groups', { preHandler: [auth, feature] }, async (req) => {
    const userId = req.user!.id;
    return {
      groups: storage.deviceGroups.listByUser(userId).map((g) => ({
        id: g.id,
        name: g.name,
        slug: g.slug,
        deviceIds: storage.deviceGroups.memberDeviceIds(g.id),
      })),
      // Not editable, but the user can name them in conversation.
      derivedGroups: ['phones', 'tablets', 'computers', 'browsers', 'all'],
    };
  });

  app.post('/api/device-groups', { preHandler: [auth, feature] }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const userId = req.user!.id;
    assertOwnedDevices(userId, body.deviceIds);

    const slug = slugifyGroup(body.name);
    if (!slug) throw Errors.badRequest('That group name has no usable characters.');
    if (storage.deviceGroups.getBySlug(userId, slug)) {
      throw Errors.conflict(`You already have a group called "${body.name}".`);
    }
    // A custom group may shadow a derived one; warn rather than forbid, since the
    // resolver deliberately prefers the explicit group.
    const shadows = isVirtualGroup(body.name);

    const group = storage.deviceGroups.create({
      userId,
      name: body.name,
      deviceIds: body.deviceIds,
    });
    return reply.status(201).send({
      group: { id: group.id, name: group.name, slug: group.slug, deviceIds: body.deviceIds },
      note: shadows
        ? `"${body.name}" also matches a built-in group. Your group will take priority.`
        : undefined,
    });
  });

  app.patch('/api/device-groups/:id', { preHandler: [auth, feature] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const userId = req.user!.id;
    const group = storage.deviceGroups.getOwned(userId, id);
    if (!group) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Group not found' });

    if (body.name && body.name !== group.name) {
      const clash = storage.deviceGroups.getBySlug(userId, slugifyGroup(body.name));
      if (clash && clash.id !== id) {
        throw Errors.conflict(`You already have a group called "${body.name}".`);
      }
      storage.deviceGroups.rename(id, body.name);
    }
    if (body.deviceIds) {
      assertOwnedDevices(userId, body.deviceIds);
      storage.deviceGroups.setMembers(id, body.deviceIds);
    }
    const fresh = storage.deviceGroups.getById(id)!;
    return {
      group: {
        id: fresh.id,
        name: fresh.name,
        slug: fresh.slug,
        deviceIds: storage.deviceGroups.memberDeviceIds(id),
      },
    };
  });

  app.delete('/api/device-groups/:id', { preHandler: [auth, feature] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const group = storage.deviceGroups.getOwned(req.user!.id, id);
    if (!group) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Group not found' });
    storage.deviceGroups.remove(id);
    return { removed: true };
  });
}
