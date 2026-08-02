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
  { id: 'owl', label: 'Owl', path: '/fog-pack/owl.svg' },
  { id: 'fox', label: 'Fox', path: '/fog-pack/fox.svg' },
  { id: 'penguin', label: 'Penguin', path: '/fog-pack/penguin.svg' },
  { id: 'elephant', label: 'Elephant', path: '/fog-pack/elephant.svg' },
  { id: 'cat', label: 'Cat', path: '/fog-pack/cat.svg' },
  { id: 'fish', label: 'Fish', path: '/fog-pack/fish.svg' },
  { id: 'crab', label: 'Crab', path: '/fog-pack/crab.svg' },
  { id: 'bee', label: 'Bee', path: '/fog-pack/bee.svg' },
  { id: 'frog', label: 'Frog', path: '/fog-pack/frog.svg' },
  { id: 'turtle', label: 'Turtle', path: '/fog-pack/turtle.svg' },
  { id: 'airplane', label: 'Airplane', path: '/fog-pack/airplane.svg' },
  { id: 'train', label: 'Train', path: '/fog-pack/train.svg' },
  { id: 'car', label: 'Car', path: '/fog-pack/car.svg' },
  { id: 'submarine', label: 'Submarine', path: '/fog-pack/submarine.svg' },
  { id: 'coffee', label: 'Coffee cup', path: '/fog-pack/coffee.svg' },
  { id: 'leaf', label: 'Leaf', path: '/fog-pack/leaf.svg' },
  { id: 'star', label: 'Star', path: '/fog-pack/star.svg' },
  { id: 'cloud', label: 'Cloud', path: '/fog-pack/cloud.svg' },
  { id: 'key', label: 'Key', path: '/fog-pack/key.svg' },
  { id: 'bell', label: 'Bell', path: '/fog-pack/bell.svg' },
  { id: 'drum', label: 'Drum', path: '/fog-pack/drum.svg' },
  { id: 'camera', label: 'Camera', path: '/fog-pack/camera.svg' },
  { id: 'lightbulb', label: 'Light bulb', path: '/fog-pack/lightbulb.svg' },
  { id: 'compass', label: 'Compass', path: '/fog-pack/compass.svg' },
];
