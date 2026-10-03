/**
 * Habitica avatar/companion asset helpers — Fingersnap M3 (owner: snap_assets).
 *
 * Layer composition follows the official Habitica avatar component
 * (website/client/src/components/avatar.vue, HabitRPG/habitica develop
 * @789bbe4ab779febbed92d92b533c70f41b9f7b09), which stacks CSS sprite
 * classes in a fixed order. Sprite names are upstream class names.
 *
 * Upstream art: https://habitica-assets.s3.amazonaws.com/mobileApp/images/
 * (individual PNG/GIF files; naming verified HTTP 200 — see
 * docs/habitica-assets.md). That host serves NO
 * Access-Control-Allow-Origin header, so remote URLs are NOT safe to load
 * as Phaser WebGL textures. The scoped same-origin cache under
 * public/assets/habitica/ is the WebGL-safe path; `assetSourceFor` reports
 * which one a name resolves to.
 *
 * Art license: CC BY-NC-SA 3.0 (HabitRPG/Weirdly Wonderful) — attribution
 * in ASSETS.md. This module holds no credentials and never performs I/O.
 */
import type { HabiticaProfile } from './types.ts';
import {
  CATALOG,
  companionSpriteNames,
  isGifSprite,
  isMountKey,
  isNonePiece,
  isPetKey,
  isTwoHanded,
} from './gear.ts';

/**
 * Optional profile fields owned by snap_state (to be added to HabiticaProfile
 * in src/lib/habitica/types.ts). Declared structurally here so avatar.ts works
 * before and after that change; HabiticaProfile is assignable to AvatarProfile.
 */
export interface AvatarProfileExtras {
  /** Costume gear map (items.gear.costume); visuals only, never combat stats. */
  costume?: Record<string, string | null> | null;
  /** True when the costume map should drive visuals (preferences.costume). */
  useCostume?: boolean;
  /** items.currentPet — validated against the bundled pet key set. */
  selectedPet?: string | null;
  /** items.currentMount — validated against the bundled mount key set. */
  selectedMount?: string | null;
}

export type AvatarProfile = HabiticaProfile & AvatarProfileExtras;

/**
 * Optional per-slot hair appearance beyond HabiticaProfile's base slot.
 * When snap_state adds these to HabiticaAppearance (mapping from
 * preferences.hair.*), they flow through automatically; until then the
 * layers are skipped and reported (appearance is PARTIAL: base hair only).
 */
export interface HairSlotExtras {
  hairBangs?: number;
  hairMustache?: number;
  hairBeard?: number;
  /** 0 / missing means no flower (upstream has no sprite for flower 0). */
  hairFlower?: number;
}

export type AvatarAppearance = HabiticaProfile['appearance'] & HairSlotExtras;
export type AvatarProfileFull = Omit<AvatarProfile, 'appearance'> & {
  appearance: AvatarAppearance;
};

/** A renderable sprite reference: `key` is the upstream sprite name. */
export interface AssetRef {
  key: string;
  url: string;
}

export interface AvatarLayerReport {
  /** Same list avatarLayersFor returns. */
  layers: AssetRef[];
  /** Human-readable reasons for layers that were not emitted. */
  skipped: string[];
  /** Sprite names emitted with upstream URLs only (not Phaser-WebGL-safe). */
  remoteOnly: string[];
}

export const UPSTREAM_SPRITE_BASE =
  'https://habitica-assets.s3.amazonaws.com/mobileApp/images/';
export const LOCAL_SPRITE_BASE = '/assets/habitica/';

/** Percent-encoded upstream URL for a sprite name (no validation). */
export function upstreamSpriteUrl(name: string): string {
  const ext = isGifSprite(name) ? 'gif' : 'png';
  return `${UPSTREAM_SPRITE_BASE}${encodeURIComponent(name)}.${ext}`;
}

/** Percent-encoded same-origin cache URL for a sprite name (no validation). */
export function localSpriteUrl(name: string): string {
  const ext = CATALOG.localSprites[name] ?? 'png';
  return `${LOCAL_SPRITE_BASE}${encodeURIComponent(name)}.${ext}`;
}

function splitHair(name: string): { slot: string; style: string; color: string } | null {
  const m = /^hair_(bangs|base|mustache|beard)_(.+)_(.+)$/.exec(name);
  if (!m) return null;
  return { slot: m[1], style: m[2], color: m[3] };
}

function isKnownSkinName(name: string): boolean {
  return name.startsWith('skin_') && CATALOG.appearances.skin.includes(name.slice(5));
}

function isKnownShirtName(name: string): boolean {
  for (const size of CATALOG.appearances.size) {
    const prefix = `${size}_shirt_`;
    if (name.startsWith(prefix)) {
      return CATALOG.appearances.shirt.includes(name.slice(prefix.length));
    }
  }
  return false;
}

function isKnownHairName(name: string): boolean {
  const parts = splitHair(name);
  if (!parts) return false;
  if (parts.style === '0') return false; // style 0 = no hair, no sprite
  const slots: Record<string, string[]> = {
    bangs: CATALOG.appearances.hair.bangs,
    base: CATALOG.appearances.hair.base,
    mustache: CATALOG.appearances.hair.mustache,
    beard: CATALOG.appearances.hair.beard,
  };
  return (
    slots[parts.slot].includes(parts.style) &&
    CATALOG.appearances.hair.color.includes(parts.color)
  );
}

function isKnownFlowerName(name: string): boolean {
  if (!name.startsWith('hair_flower_')) return false;
  const n = name.slice('hair_flower_'.length);
  return n !== '0' && CATALOG.appearances.hair.flower.includes(n);
}

function isKnownChairName(name: string): boolean {
  if (!name.startsWith('chair_')) return false;
  const c = name.slice('chair_'.length);
  return c !== 'none' && CATALOG.appearances.chair.includes(c);
}

function gearKeyForSprite(name: string): string | null {
  for (const size of CATALOG.appearances.size) {
    const prefix = `${size}_`;
    if (name.startsWith(prefix)) {
      const key = name.slice(prefix.length);
      return CATALOG.gear[key]?.type === 'armor' ? key : null;
    }
  }
  return name in CATALOG.gear ? name : null;
}

function isKnownGearName(name: string): boolean {
  const key = gearKeyForSprite(name);
  return key !== null && !isNonePiece(key);
}

function isKnownCompanionName(name: string): boolean {
  if (name.startsWith('Pet-')) return isPetKey(name.slice(4));
  if (name.startsWith('Mount_Body_')) return isMountKey(name.slice(11));
  if (name.startsWith('Mount_Head_')) return isMountKey(name.slice(11));
  return false;
}

/**
 * Resolve a sprite name to its render source: 'local' for the bundled
 * same-origin cache, 'remote' for upstream-only art, null when the name is
 * not a known upstream sprite (never invents names).
 */
export function assetSourceFor(name: string): 'local' | 'remote' | null {
  if (Object.prototype.hasOwnProperty.call(CATALOG.localSprites, name)) {
    return 'local';
  }
  const known =
    name === 'head_0' ||
    isKnownSkinName(name) ||
    isKnownShirtName(name) ||
    isKnownHairName(name) ||
    isKnownFlowerName(name) ||
    isKnownChairName(name) ||
    isKnownGearName(name) ||
    isKnownCompanionName(name);
  return known ? 'remote' : null;
}

/** Validated URL for a sprite name, or null when the name is not renderable. */
export function spriteUrlFor(name: string): string | null {
  const source = assetSourceFor(name);
  if (source === 'local') return localSpriteUrl(name);
  if (source === 'remote') return upstreamSpriteUrl(name);
  return null;
}

function refOrSkip(
  name: string,
  skipped: string[],
  remoteOnly: string[],
  slot: string,
): AssetRef | null {
  const url = spriteUrlFor(name);
  if (!url) {
    skipped.push(`${slot}: no known upstream sprite '${name}'`);
    return null;
  }
  if (assetSourceFor(name) === 'remote') remoteOnly.push(name);
  return { key: name, url };
}

/**
 * Compose the avatar's sprite layers bottom-to-top in official Habitica
 * order (mount body, back, skin, shirt, head_0, size-armored body, collar,
 * hair, body, eyewear, head, head accessory, shield, weapon, mount head,
 * pet). Missing/unsupported pieces are skipped and reported by
 * `avatarLayerReport` — never silently renamed or invented.
 *
 * Combat stats always come from `equipped`; the `costume` map drives
 * visuals only when `useCostume` is true (upstream `preferences.costume`
 * behavior). Two-handed weapons suppress the shield (upstream rule).
 */
export function avatarLayersFor(profile: AvatarProfileFull): AssetRef[] {
  return avatarLayerReport(profile).layers;
}

/** `avatarLayersFor` plus the skip/fallback report. */
export function avatarLayerReport(profile: AvatarProfileFull): AvatarLayerReport {
  const layers: AssetRef[] = [];
  const skipped: string[] = [];
  const remoteOnly: string[] = [];

  const push = (name: string, slot: string) => {
    const ref = refOrSkip(name, skipped, remoteOnly, slot);
    if (ref) layers.push(ref);
  };

  const visuals: Record<string, string | null> =
    profile.useCostume === true && profile.costume
      ? { ...profile.costume }
      : { ...profile.equipped };

  const gearKey = (slot: string): string | null => {
    const raw = visuals[slot];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    if (!isKnownGearKeySafe(raw)) {
      skipped.push(`${slot}: unknown gear key '${raw}'`);
      return null;
    }
    if (isNonePiece(raw)) return null;
    return raw;
  };

  const mount =
    typeof profile.selectedMount === 'string' && profile.selectedMount.length > 0
      ? profile.selectedMount
      : null;
  if (mount) {
    if (isMountKey(mount)) {
      push(`Mount_Body_${mount}`, 'mount.body');
    } else {
      skipped.push(`mount: unknown mount key '${mount}'`);
    }
  }

  // Upstream draws the flower twice (here and after head accessories).
  const flowerSlot = profile.appearance.hairFlower;
  const flowerName =
    flowerSlot !== undefined && String(flowerSlot) !== '0'
      ? `hair_flower_${flowerSlot}`
      : null;
  if (flowerName && CATALOG.appearances.hair.flower.includes(String(flowerSlot))) {
    push(flowerName, 'hair.flower');
  } else if (flowerName) {
    skipped.push(`hair.flower: unknown flower '${flowerSlot}'`);
  }
  skipped.push('chair: not representable in HabiticaProfile (upstream chair_* layer omitted)');

  const back = gearKey('back');
  if (back) push(back, 'back');

  const { size, shirt, skin, hairColor } = profile.appearance;
  if (CATALOG.appearances.skin.includes(skin)) {
    push(`skin_${skin}`, 'skin');
  } else {
    skipped.push(`skin: unknown skin '${skin}'`);
  }

  if (
    CATALOG.appearances.size.includes(size) &&
    CATALOG.appearances.shirt.includes(shirt)
  ) {
    push(`${size}_shirt_${shirt}`, 'shirt');
  } else {
    skipped.push(`shirt: unknown size/shirt combination '${size}'/'${shirt}'`);
  }

  push('head_0', 'head.base');

  const armor = gearKey('armor');
  if (armor) {
    if (CATALOG.appearances.size.includes(size)) {
      push(`${size}_${armor}`, 'armor');
    } else {
      skipped.push(`armor: unknown size '${size}' for armor '${armor}'`);
    }
  }

  const collar = gearKey('back_collar');
  if (collar) push(collar, 'back_collar');

  const hairSlots: Array<[string, number | undefined, string[], string]> = [
    ['hair.bangs', profile.appearance.hairBangs, CATALOG.appearances.hair.bangs, 'bangs'],
    ['hair.base', profile.appearance.hairStyle, CATALOG.appearances.hair.base, 'base'],
    ['hair.mustache', profile.appearance.hairMustache, CATALOG.appearances.hair.mustache, 'mustache'],
    ['hair.beard', profile.appearance.hairBeard, CATALOG.appearances.hair.beard, 'beard'],
  ];
  for (const [slotLabel, rawStyle, valid, prefix] of hairSlots) {
    if (rawStyle === undefined) {
      if (slotLabel !== 'hair.base') {
        skipped.push(`${slotLabel}: not representable in HabiticaProfile appearance (optional hair slots unset)`);
      }
      continue;
    }
    const s = String(rawStyle);
    if (s === '0') continue; // style 0 = none, intentional
    if (!valid.includes(s) || !CATALOG.appearances.hair.color.includes(hairColor)) {
      skipped.push(`${slotLabel}: unknown hair style/color '${s}'/'${hairColor}'`);
      continue;
    }
    push(`hair_${prefix}_${s}_${hairColor}`, slotLabel);
  }

  const body = gearKey('body');
  if (body) push(body, 'body');

  const eyewear = gearKey('eyewear');
  if (eyewear) push(eyewear, 'eyewear');

  const head = gearKey('head');
  if (head) push(head, 'head');

  const headAccessory = gearKey('headAccessory');
  if (headAccessory) push(headAccessory, 'headAccessory');

  // Upstream's second (upper) flower copy — matches avatar.vue order.
  if (flowerName && CATALOG.appearances.hair.flower.includes(String(flowerSlot))) {
    push(flowerName, 'hair.flower.top');
  }

  const shield = gearKey('shield');
  const weapon = gearKey('weapon');
  if (shield) {
    if (weapon && isTwoHanded(weapon)) {
      skipped.push(`shield: hidden by two-handed weapon '${weapon}' (upstream rule)`);
    } else {
      push(shield, 'shield');
    }
  }
  if (weapon) push(weapon, 'weapon');

  if (mount && isMountKey(mount)) push(`Mount_Head_${mount}`, 'mount.head');

  const pet =
    typeof profile.selectedPet === 'string' && profile.selectedPet.length > 0
      ? profile.selectedPet
      : null;
  if (pet) {
    if (isPetKey(pet)) {
      push(`Pet-${pet}`, 'pet');
    } else {
      skipped.push(`pet: unknown pet key '${pet}'`);
    }
  }

  return { layers, skipped, remoteOnly };
}

function isKnownGearKeySafe(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG.gear, key);
}

/**
 * Canonical companion sprite for a selected pet/mount key, or null for
 * empty/unknown keys (never guesses names). Mounts return the body sprite;
 * use `companionLayersFor` for the full body+head pair.
 */
export function companionAssetFor(
  key: string,
  kind: 'pet' | 'mount',
): AssetRef | null {
  const names = companionSpriteNames(key, kind);
  const name = names[0];
  if (!name) return null;
  const url = spriteUrlFor(name);
  if (!url) return null;
  return { key: name, url };
}

/** All sprite layers for a companion (mounts: body + head). */
export function companionLayersFor(
  key: string,
  kind: 'pet' | 'mount',
): AssetRef[] {
  const out: AssetRef[] = [];
  for (const name of companionSpriteNames(key, kind)) {
    const url = spriteUrlFor(name);
    if (url) out.push({ key: name, url });
  }
  return out;
}
