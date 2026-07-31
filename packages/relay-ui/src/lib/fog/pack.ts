// Bundled object pack for the Fog game, mirroring lib/stickers.ts:
// each entry is a small flat SVG under /public/fog-pack/ so the "pack"
// category works offline and is always available as the fallback
// round source. Labels double as the answers (and the distractor
// pool).
//
// Adding an object: drop the SVG in public/fog-pack/, add an entry
// here, ship. No backend involvement.

export interface FogPackItem {
  id: string;
  label: string;
  path: string;
}

export const FOG_PACK: ReadonlyArray<FogPackItem> = [
  { id: 'umbrella', label: 'Umbrella', path: '/fog-pack/umbrella.svg' },
  { id: 'rocket', label: 'Rocket', path: '/fog-pack/rocket.svg' },
  { id: 'bicycle', label: 'Bicycle', path: '/fog-pack/bicycle.svg' },
  { id: 'cactus', label: 'Cactus', path: '/fog-pack/cactus.svg' },
  { id: 'lighthouse', label: 'Lighthouse', path: '/fog-pack/lighthouse.svg' },
  { id: 'snowman', label: 'Snowman', path: '/fog-pack/snowman.svg' },
  { id: 'anchor', label: 'Anchor', path: '/fog-pack/anchor.svg' },
  { id: 'butterfly', label: 'Butterfly', path: '/fog-pack/butterfly.svg' },
  { id: 'mushroom', label: 'Mushroom', path: '/fog-pack/mushroom.svg' },
  { id: 'balloon', label: 'Hot-air balloon', path: '/fog-pack/balloon.svg' },
  { id: 'sailboat', label: 'Sailboat', path: '/fog-pack/sailboat.svg' },
  { id: 'telescope', label: 'Telescope', path: '/fog-pack/telescope.svg' },
  { id: 'teapot', label: 'Teapot', path: '/fog-pack/teapot.svg' },
  { id: 'ladybug', label: 'Ladybug', path: '/fog-pack/ladybug.svg' },
  { id: 'palmtree', label: 'Palm tree', path: '/fog-pack/palmtree.svg' },
  { id: 'campfire', label: 'Campfire', path: '/fog-pack/campfire.svg' },
  { id: 'windmill', label: 'Windmill', path: '/fog-pack/windmill.svg' },
  { id: 'whale', label: 'Whale', path: '/fog-pack/whale.svg' },
  { id: 'castle', label: 'Castle', path: '/fog-pack/castle.svg' },
  { id: 'robot', label: 'Robot', path: '/fog-pack/robot.svg' },
  { id: 'icecream', label: 'Ice cream', path: '/fog-pack/icecream.svg' },
  { id: 'crown', label: 'Crown', path: '/fog-pack/crown.svg' },
  { id: 'moon', label: 'Moon', path: '/fog-pack/moon.svg' },
  { id: 'pizza', label: 'Pizza', path: '/fog-pack/pizza.svg' },
];
