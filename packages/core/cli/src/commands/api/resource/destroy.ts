/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Command } from '@oclif/core';
import { buildDestroyArgs, destroyFlags, runResourceCommand } from '../../../lib/resource-command.js';

export default class ResourceDestroy extends Command {
  static summary = 'Delete records from a resource';

  static description = 'Delete records from a generic resource. Target records with --filter-by-tk or --filter.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --resource users --filter-by-tk 1',
    `<%= config.bin %> <%= command.id %> --resource posts --filter '{"status":"archived"}'`,
  ];

  static flags = destroyFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(ResourceDestroy);
    await runResourceCommand(this, 'destroy', flags, buildDestroyArgs(flags));
  }
}
