import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLanInvite } from '../src/lan-hub';
import {
  deriveLanHubId,
  deriveLanHubUserId,
  readLanHubSettings,
  type LanHubSettings,
} from '../src/node/lan-hub';
import { LanHubStore } from '../src/node/lan-hub-store';

const HOME_INVITE = 'lody-lan://home-token@100.64.0.1:8788/Home';
const OFFICE_INVITE = 'lody-lan://office-token@10.0.1.1:8788/Office';

let directory: string;
let filePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-lan-hub-store-'));
  filePath = path.join(directory, 'lan-hub.json');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function createStore(env: NodeJS.ProcessEnv = {}) {
  let onChange: (settings: LanHubSettings) => void = () => {};
  let onError: (error: unknown) => void = () => {};
  const store = new LanHubStore({
    env,
    filePath,
    hostname: 'macbook.tail1234.ts.net',
    watch: (options) => {
      onChange = options.onChange;
      onError = options.onError;
      return { close: () => {} };
    },
  });
  return {
    store,
    /** What the watcher reports after another process edited the file. */
    editedElsewhere: () => {
      try {
        onChange(readLanHubSettings({ env, filePath }));
      } catch (error) {
        onError(error);
      }
    },
  };
}

describe('LanHubStore', () => {
  it('starts without a LAN and names the machine after its host', () => {
    expect(createStore().store.getState()).toEqual({
      editable: true,
      error: null,
      machineName: { name: 'macbook', explicit: false },
      lans: [],
    });
  });

  it('joins several LANs and never hands out a credential with their summaries', () => {
    const { store } = createStore();

    const home = store.join({ invite: HOME_INVITE });
    const office = store.join({ invite: OFFICE_INVITE, name: 'Work' });

    expect(home).toMatchObject({ ok: true, lan: { name: 'Home', url: 'http://100.64.0.1:8788' } });
    expect(office).toMatchObject({ ok: true, lan: { name: 'Work', slug: 'work' } });
    expect(store.getState().lans).toEqual([
      {
        id: deriveLanHubId('home-token'),
        name: 'Home',
        url: 'http://100.64.0.1:8788',
        slug: 'lan-home',
        workspaceId: `lw_${deriveLanHubId('home-token')}`,
        userId: deriveLanHubUserId('home-token'),
      },
      {
        id: deriveLanHubId('office-token'),
        name: 'Work',
        url: 'http://10.0.1.1:8788',
        slug: 'work',
        workspaceId: `lw_${deriveLanHubId('office-token')}`,
        userId: deriveLanHubUserId('office-token'),
      },
    ]);
    expect(JSON.stringify(store.getState())).not.toContain('-token');
    expect(readLanHubSettings({ env: {}, filePath }).hubs.map((hub) => hub.token)).toEqual([
      'home-token',
      'office-token',
    ]);
  });

  it('resolves the credential of the LAN a renderer addressed', () => {
    const { store } = createStore();
    store.join({ invite: HOME_INVITE });

    expect(store.resolve(deriveLanHubId('home-token'))).toMatchObject({
      url: 'http://100.64.0.1:8788',
      token: 'home-token',
    });
    expect(store.resolve(deriveLanHubId('office-token'))).toBeNull();
    expect(store.resolve('hub')).toBeNull();
  });

  it('renames, moves and leaves a LAN', () => {
    const { store } = createStore();
    store.join({ invite: HOME_INVITE });
    store.join({ invite: OFFICE_INVITE });
    const id = deriveLanHubId('home-token');

    expect(store.update({ id, name: 'Flat', url: '192.168.1.5:8788' })).toMatchObject({
      ok: true,
      lan: { id, name: 'Flat', url: 'http://192.168.1.5:8788', slug: 'flat' },
    });
    expect(store.remove({ id })).toMatchObject({ ok: true });
    expect(store.getState().lans.map((lan) => lan.name)).toEqual(['Office']);
    expect(store.resolve(id)).toBeNull();
  });

  it('hands out an invite that joins the same LAN', () => {
    const { store } = createStore();
    store.join({ invite: HOME_INVITE });

    const result = store.getInvite({ id: deriveLanHubId('home-token') });

    expect(result).toEqual({ ok: true, invite: HOME_INVITE });
    expect(result.ok && parseLanInvite(result.invite).token).toBe('home-token');
    expect(store.getInvite({ id: deriveLanHubId('office-token') })).toMatchObject({
      ok: false,
      code: 'unknown_hub',
    });
  });

  it('explains what is wrong with an edit and changes nothing', () => {
    const { store } = createStore();
    store.join({ invite: HOME_INVITE });
    const before = fs.readFileSync(filePath, 'utf8');

    expect(store.join({ invite: 'http://100.64.0.1:8788' })).toMatchObject({
      ok: false,
      code: 'invalid_invite',
    });
    expect(store.add({ url: 'ftp://host', token: 'x' })).toMatchObject({
      ok: false,
      code: 'invalid_url',
      message: 'LAN address must use http or https',
    });
    expect(store.join({ invite: OFFICE_INVITE, name: 'home' })).toMatchObject({
      ok: false,
      code: 'duplicate_name',
    });
    expect(store.update({ id: 'missing', name: 'X' })).toMatchObject({
      ok: false,
      code: 'unknown_hub',
    });
    expect(store.setMachineName({ name: 'x'.repeat(65) })).toMatchObject({
      ok: false,
      code: 'invalid_name',
    });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    expect(store.getState().lans.map((lan) => lan.name)).toEqual(['Home']);
  });

  it('names the machine the same in every LAN until the name is reset', () => {
    const { store } = createStore();
    store.join({ invite: HOME_INVITE });

    expect(store.setMachineName({ name: '  Studio   Mac ' })).toMatchObject({
      ok: true,
      state: { machineName: { name: 'Studio Mac', explicit: true } },
    });
    expect(readLanHubSettings({ env: {}, filePath }).machineName).toBe('Studio Mac');
    expect(store.setMachineName({ name: null })).toMatchObject({
      ok: true,
      state: { machineName: { name: 'macbook', explicit: false }, lans: [{ name: 'Home' }] },
    });
  });

  it('follows a LAN that another process joined', () => {
    const { store, editedElsewhere } = createStore();
    const seen: string[][] = [];
    store.start();
    store.subscribe(() => seen.push(store.getState().lans.map((lan) => lan.name)));

    createStore().store.join({ invite: HOME_INVITE });
    editedElsewhere();

    expect(seen).toEqual([['Home']]);
    expect(store.resolve(deriveLanHubId('home-token'))?.token).toBe('home-token');
  });

  it('does not overwrite an edit another process made in the meantime', () => {
    const { store } = createStore();
    createStore().store.join({ invite: HOME_INVITE });

    // This store has not heard of Home yet.
    store.join({ invite: OFFICE_INVITE });

    expect(store.getState().lans.map((lan) => lan.name)).toEqual(['Home', 'Office']);
  });

  it('keeps reaching its LANs while the settings are unreadable, and says so', () => {
    const { store, editedElsewhere } = createStore();
    store.join({ invite: HOME_INVITE });
    store.start();

    fs.writeFileSync(filePath, '{');
    editedElsewhere();

    expect(store.getState().error).toMatch(/not valid JSON/);
    expect(store.resolve(deriveLanHubId('home-token'))?.url).toBe('http://100.64.0.1:8788');
    expect(store.join({ invite: OFFICE_INVITE })).toMatchObject({ ok: false, code: 'write_failed' });
  });

  it('shows a LAN given by the environment and refuses to edit it', () => {
    const { store } = createStore({
      LODY_LAN_HUB_URL: 'http://10.0.0.9:8788',
      LODY_LAN_HUB_TOKEN: 'fixed-token',
    });

    expect(store.getState()).toMatchObject({
      editable: false,
      lans: [{ url: 'http://10.0.0.9:8788' }],
    });
    expect(store.join({ invite: HOME_INVITE })).toMatchObject({ ok: false, code: 'not_editable' });
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
