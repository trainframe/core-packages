import { type Static, Type } from '@sinclair/typebox';
import { CapabilityId } from './capabilities.js';

const SemverString = Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' });

export const DeviceManifest = Type.Object({
  manifest_version: Type.Literal('1.0'),

  vendor: Type.String({ pattern: '^[a-z0-9.-]+$', minLength: 3 }),
  device_kind: Type.String({ minLength: 1 }),
  version: SemverString,
  protocol_version: SemverString,

  display_name: Type.String(),
  description: Type.String(),
  documentation_url: Type.Optional(Type.String({ format: 'uri' })),

  capabilities: Type.Array(CapabilityId, { minItems: 1 }),

  custom_events: Type.Optional(
    Type.Array(
      Type.Object({
        event_type: Type.String(),
        description: Type.String(),
        schema: Type.Optional(Type.Unknown()),
        schema_url: Type.Optional(Type.String({ format: 'uri' })),
      }),
    ),
  ),

  custom_commands: Type.Optional(
    Type.Array(
      Type.Object({
        command_type: Type.String(),
        description: Type.String(),
        schema: Type.Optional(Type.Unknown()),
        schema_url: Type.Optional(Type.String({ format: 'uri' })),
      }),
    ),
  ),

  configuration: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String(),
        type: Type.Union([
          Type.Literal('string'),
          Type.Literal('integer'),
          Type.Literal('number'),
          Type.Literal('boolean'),
          Type.Literal('duration_ms'),
        ]),
        description: Type.String(),
        default: Type.Optional(Type.Unknown()),
      }),
    ),
  ),

  display: Type.Optional(
    Type.Object({
      icon: Type.Optional(Type.String()),
      svg: Type.Optional(Type.String()),
      colour: Type.Optional(Type.String()),
    }),
  ),
});

export type DeviceManifest = Static<typeof DeviceManifest>;
