/**
 * Convex Schema definition for migrated NocoBase collections.
 */

export interface FieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  required?: boolean;
}

export interface CollectionDefinition {
  name: string;
  fields: Record<string, FieldDefinition>;
}

export function defineTable(definition: CollectionDefinition): CollectionDefinition {
  return definition;
}

export function defineSchema<T extends Record<string, CollectionDefinition>>(tables: T): { tables: T } {
  return { tables };
}

export default defineSchema({
  users: defineTable({
    name: 'users',
    fields: {
      email: { name: 'email', type: 'string', required: true },
      name: { name: 'name', type: 'string' },
      role: { name: 'role', type: 'string' },
    },
  }),
  collections: defineTable({
    name: 'collections',
    fields: {
      name: { name: 'name', type: 'string', required: true },
      title: { name: 'title', type: 'string' },
      options: { name: 'options', type: 'json' },
    },
  }),
});
