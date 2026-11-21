// Sokoban solver — make.fun sokoban-solver-01-run-20261121.
//
// Idea: a generated level is a hallway with one to four small rooms off it,
// each room holding 3 or 4 boxes and as many goals, and a box pushed out of a
// room can never come back. So the level splits into independent rooms, and
// the push-optimal total is the sum of the rooms' push-optimal counts: solve
// each room on its own, in turn, and walk the player on between rooms.
//
// Each room is solved by a breadth-first search over pushes (every push costs
// one, so the first solved state found is push-optimal). A state is the boxes'
// squares plus the region the player can reach around them, named by its
// lowest square. Two prunings keep the search small, and neither removes a
// solvable state: a box may only be pushed onto a "live" square (a square from
// which a box alone can still reach a goal, found by pulling backwards from
// the goals), and a push that leaves a box frozen inside a 2x2 block of walls
// and boxes, off its goal, is dropped. If that search gives up on a room, a
// best-first (A*) search over the same states, guided by each box's distance
// to its nearest goal, tries again for any valid solution instead of none.
//
// The search is budgeted by states counted, never by the clock, so two runs
// of this program write the same bytes. No randomness, no wall clock.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets, counted in states. A room the generator keeps always solves inside the room cap. */
const ROOM_STATE_CAP = 250_000;
const LEVEL_STATE_CAP = 250_000;

interface Board {
  w: number;
  h: number;
  /** 1 is a wall, 0 is open floor. The outer frame is always wall. */
  wall: Uint8Array;
  /** Goal squares, sorted. */
  goals: number[];
  /** 1 on a goal square. */
  goal: Uint8Array;
  /** Box squares, sorted. */
  boxes: number[];
  player: number;
}

interface Dir {
  dx: number;
  dy: number;
  /** The letter for a plain step. */
  walk: string;
  /** The letter for a step that pushes a box. */
  push: string;
}

const DIRS: Dir[] = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

/** Read a level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  const goal = new Uint8Array(w * h);
  for (const g of goals) goal[g] = 1;
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goal, boxes, player };
}

/**
 * The squares a lone box can still be pushed from onto some goal. Found by
 * pulling backwards: a goal is live, and a square is live when the box on it
 * can be pushed one step towards a live square with the player standing
 * behind it (that square behind must be open floor too).
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const d of DIRS) {
      const step = d.dy * b.w + d.dx;
      const y = x - step;
      if (!b.wall[y] && !b.wall[y - step] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * For every square, the fewest steps a box needs to reach some goal, ignoring
 * the other boxes. A lower bound on the pushes still needed, so it guides the
 * rescue search without ever overestimating.
 */
function goalDistances(b: Board): Int32Array {
  const dist = new Int32Array(b.w * b.h).fill(-1);
  const queue: number[] = [];
  for (const g of b.goals) {
    dist[g] = 0;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const d of DIRS) {
      const q = p + d.dy * b.w + d.dx;
      if (!b.wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * Flood-fill the squares the player reaches from `from` with `blocked` (boxes)
 * in the way, stamping them in `seen`. Returns the lowest reached square, which
 * names the region: two states with the same boxes and the same region name are
 * the same state, whatever square the player stands on inside the region.
 */
function floodRegion(
  b: Board,
  blocked: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const d of DIRS) {
      const q = p + d.dy * b.w + d.dx;
      if (b.wall[q] === 0 && blocked[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed onto `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes with a box among them off its goal. Such a box
 * can never move again, so the state is dead.
 */
function frozenBlock(b: Board, blocked: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c1 = a + 1;
    const c2 = a + w;
    const c3 = c2 + 1;
    if (!(b.wall[a] || blocked[a]) || !(b.wall[c1] || blocked[c1]) || !(b.wall[c2] || blocked[c2]) || !(b.wall[c3] || blocked[c3])) continue;
    if ((blocked[a] && !b.goal[a]) || (blocked[c1] && !b.goal[c1]) || (blocked[c2] && !b.goal[c2]) || (blocked[c3] && !b.goal[c3])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case letters. */
function walkTo(b: Board, blocked: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.w * b.h).fill(-1);
  const how: string[] = new Array(b.w * b.h);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * b.w + d.dx;
      if (b.wall[q] || blocked[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after walking `moves` (case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Solved {
  pushes: number;
  moves: string;
}

/** A heap entry for the rescue search: [estimate, pushes so far, state]. Lower estimate first, deeper first on ties. */
type HeapEntry = [number, number, number];

/**
 * A solution of a board: {pushes, moves} (moves in LURD, an upper-case letter
 * marking a push), or null when the search gives up inside `cap` states or the
 * board has no solution. Breadth-first over pushes in 'bfs' mode, so the first
 * solved state found is push-optimal; best-first by pushes plus the boxes'
 * distance to their nearest goals in 'astar' mode, a rescue that settles for
 * any valid solution when breadth-first gives up.
 *
 * States are kept in flat growing arrays: the boxes of state s live at
 * store[s * n .. s * n + n), its parent at parent[s], the push that made it at
 * pushFrom[s] -> pushTo[s], the player's square at playerAt[s] and its pushes
 * at depth[s]. The queue is the states themselves in discovery order (a head
 * pointer walks it) for breadth-first, a heap on the estimate for best-first.
 */
function solvePushes(b: Board, cap: number, mode: 'bfs' | 'astar'): Solved | null {
  const size = b.w * b.h;
  const n = b.boxes.length;
  const live = liveSquares(b);
  if (b.boxes.some((x) => !live[x])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((x) => b.goal[x]);
  if (solved(b.boxes)) return { pushes: 0, moves: '' };
  const dist = mode === 'astar' ? goalDistances(b) : null;
  const estimate = (boxes: number[]): number => {
    let h = 0;
    for (const x of boxes) h += dist![x]! < 0 ? 1_000_000 : dist![x]!;
    return h;
  };

  const blocked = new Uint8Array(size);
  const seen = new Int32Array(size);
  const stampOf = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // A state's key: its region's lowest square, then its boxes, as digits in
  // base `size`. Exact while size ** (n + 1) stays under 2 ** 53, which holds
  // for a room of up to five boxes; with more boxes the key is a string.
  const manyBoxes = n > 5;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (manyBoxes) return low + ':' + boxes.join(',');
    let k = low;
    for (const x of boxes) k = k * size + x;
    return k;
  };

  let capacity = 4096;
  let store = new Int32Array(capacity * n);
  let parent = new Int32Array(capacity).fill(-1);
  let pushFrom = new Int32Array(capacity);
  let pushTo = new Int32Array(capacity);
  let playerAt = new Int32Array(capacity);
  let depth = new Int32Array(capacity);
  const grow = (): void => {
    const next = capacity * 2;
    const ns = new Int32Array(next * n);
    ns.set(store);
    store = ns;
    const np = new Int32Array(next).fill(-1);
    np.set(parent);
    parent = np;
    const nf = new Int32Array(next);
    nf.set(pushFrom);
    pushFrom = nf;
    const nt = new Int32Array(next);
    nt.set(pushTo);
    pushTo = nt;
    const na = new Int32Array(next);
    na.set(playerAt);
    playerAt = na;
    const nd = new Int32Array(next);
    nd.set(depth);
    depth = nd;
    capacity = next;
  };
  const boxesOf = (s: number): number[] => Array.from(store.subarray(s * n, s * n + n));

  // The heap for best-first: smaller estimate first, deeper first on ties,
  // earlier state first after that, so the order is fixed.
  const heap: HeapEntry[] = [];
  const heapLess = (a: HeapEntry, b: HeapEntry): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: HeapEntry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): HeapEntry => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const index = new Map<number | string, number>();
  store.set(b.boxes, 0);
  playerAt[0] = b.player;
  depth[0] = 0;
  for (const x of b.boxes) blocked[x] = 1;
  index.set(keyOf(b.boxes, floodRegion(b, blocked, b.player, seen, ++stamp, stack)), 0);
  for (const x of b.boxes) blocked[x] = 0;
  if (mode === 'astar') heapPush([estimate(b.boxes), 0, 0]);
  let count = 1;
  let found = -1;
  let head = 0;

  while (found < 0 && (mode === 'bfs' ? head < count : heap.length > 0)) {
    const s = mode === 'bfs' ? head++ : heapPop()[2];
    const boxes = boxesOf(s);
    for (const x of boxes) blocked[x] = 1;
    floodRegion(b, blocked, playerAt[s]!, seen, ++stamp, stack);
    const region = stamp;
    for (let bi = 0; bi < n && found < 0; bi++) {
      const box = boxes[bi]!;
      for (const d of DIRS) {
        const step = d.dy * b.w + d.dx;
        const t = box + step;
        if (seen[box - step] !== region || b.wall[t] || blocked[t] || !live[t]) continue;
        // Try the push: the box moves to t, the player ends on its old square.
        blocked[box] = 0;
        blocked[t] = 1;
        const frozen = frozenBlock(b, blocked, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, floodRegion(b, blocked, box, stampOf, ++stamp, stack));
        }
        blocked[t] = 0;
        blocked[box] = 1;
        if (frozen || index.has(key)) continue;
        if (count >= cap) {
          for (const x of boxes) blocked[x] = 0;
          return null;
        }
        if (count >= capacity) grow();
        index.set(key, count);
        store.set(next!, count * n);
        playerAt[count] = box;
        parent[count] = s;
        pushFrom[count] = box;
        pushTo[count] = t;
        depth[count] = depth[s]! + 1;
        if (mode === 'astar') heapPush([depth[count] + estimate(next!), depth[count], count]);
        if (solved(next!)) {
          found = count;
          break;
        }
        count++;
      }
    }
    for (const x of boxes) blocked[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of path) {
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const step = to - from;
    const dir = DIRS.find((d) => d.dy * b.w + d.dx === step)!;
    for (const x of boxes) blocked[x] = 1;
    moves += walkTo(b, blocked, player, from - step);
    for (const x of boxes) blocked[x] = 0;
    moves += dir.push;
    player = from;
    const at = boxes.indexOf(from);
    boxes[at] = to;
    boxes.sort((x, y) => x - y);
  }
  return { pushes: path.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room. Null when some part holds more or fewer boxes than goals, or
 * a box starts in the hallway: then the level is no set of rooms.
 */
function splitRooms(b: Board): Room[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.w * b.h);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) {
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.w * b.h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < b.w * b.h; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const d of DIRS) {
        const q = squares[i]! + d.dy * b.w + d.dx;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const x of b.boxes) rooms[part[x]!]!.boxes.push(x);
  for (const g of b.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve one level: room by room, each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's. A room the
 * breadth-first search gives up on is retried best-first, for any valid
 * solution rather than none. Falls back to solving the whole level at once
 * when it is no set of rooms, or a room's search gives up. Returns the moves,
 * or '' when nothing solves it.
 */
function solveLevel(text: string): string {
  const board = parseLevel(text);
  const rooms = splitRooms(board);
  if (rooms !== null) {
    let player = board.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = board.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const x of other.done ? other.goals : other.boxes) wall[x] = 1;
      }
      const goal = new Uint8Array(board.w * board.h);
      for (const g of room.goals) goal[g] = 1;
      const sub: Board = {
        w: board.w,
        h: board.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        goal,
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushes(sub, ROOM_STATE_CAP, 'bfs') ?? solvePushes(sub, ROOM_STATE_CAP, 'astar');
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = endOf(board.w, player, solved.moves);
      room.done = true;
    }
    if (ok) return moves;
  }
  return solvePushes(board, LEVEL_STATE_CAP, 'bfs')?.moves ?? solvePushes(board, LEVEL_STATE_CAP, 'astar')?.moves ?? '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch (err) {
    console.error(`sokoban: ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    moves = '';
  }
  if (moves === '') console.error(`sokoban: ${id} unsolved, writing an empty solution`);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
