// 子 agent 任务说明开头的重复段落。有人给每个子 agent 的任务说明都以同一段话开头（“开始前先读 …”），
// 这一段对每个子 agent 都一样，没有信息；这里算出每个任务说明开头有多少个字符是大家共有的，界面据此把它折起来。

/** 至少这么多个任务说明在同一个位置逐字出现同一段，才算“大家共有”。只有一两个子 agent 时不折。 */
export const FOLD_MIN_PROMPTS = 3;
/** 只在任务说明开头这么多个字符里找段落：共有的开头不会更长，再长的不值得算。 */
export const FOLD_SCAN_CHARS = 4000;

/** 空行（两个以上换行，行内可以有空白）：段落之间的分隔。 */
const SEPARATOR = /(?:\r?\n[ \t]*){2,}/g;

interface Prefixes {
  /** 第 k 个段落（连同它后面的空行）结束的位置，也就是前 k 段的字符数；不含最后一段（至少留一段不折）。 */
  ends: number[];
  /** 前 k 段的内容摘要：从第一段起逐段累加，所以相同的开头得到相同的键。 */
  keys: string[];
}

/** cyrb53：53 位的字符串哈希。seed 用上一段的结果，键就和前面所有段落有关。 */
function hash(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function prefixesOf(text: string): Prefixes {
  const ends: number[] = [];
  const keys: string[] = [];
  let from = 0;
  let chain = 0;
  for (const match of text.matchAll(SEPARATOR)) {
    const end = match.index + match[0].length;
    if (end > FOLD_SCAN_CHARS || end >= text.length) break;
    // 键只看段落的文字，不看后面的空行有几个：同一段话后面空一行还是两行，算同一段
    chain = hash(text.slice(from, match.index), chain);
    ends.push(end);
    keys.push(`${ends.length}:${chain}`);
    from = end;
  }
  return { ends, keys };
}

/**
 * 每个子 agent 的任务说明开头可以折叠多少个字符。按“段落”（空行隔开）为单位：从开头起、连续几个段落在至少 FOLD_MIN_PROMPTS 个
 * 任务说明里都逐字出现在同一个位置，这几个段落的长度（含后面的空行）就是可折叠的长度。至少留最后一段不折，所以整份说明都相同时也不会全折起来。
 * 一边加任务说明一边算：add 只处理新加的，fold 查表。
 */
export class PromptFolds {
  readonly #prompts = new Map<string, Prefixes>();
  readonly #counts = new Map<string, number>();

  /** 记下 id 的任务说明（已经有就换掉）。 */
  add(id: string, text: string): void {
    this.#forget(id);
    const prefixes = prefixesOf(text);
    this.#prompts.set(id, prefixes);
    for (const key of prefixes.keys) this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  /** id 的任务说明开头可以折叠的字符数；没有共有的开头、不认识这个 id 是 0。 */
  fold(id: string): number {
    const prefixes = this.#prompts.get(id);
    if (!prefixes) return 0;
    for (let i = prefixes.keys.length - 1; i >= 0; i--) {
      if ((this.#counts.get(prefixes.keys[i]!) ?? 0) >= FOLD_MIN_PROMPTS) return prefixes.ends[i]!;
    }
    return 0;
  }

  get size(): number {
    return this.#prompts.size;
  }

  ids(): IterableIterator<string> {
    return this.#prompts.keys();
  }

  #forget(id: string): void {
    const old = this.#prompts.get(id);
    if (!old) return;
    for (const key of old.keys) {
      const left = (this.#counts.get(key) ?? 1) - 1;
      if (left <= 0) this.#counts.delete(key);
      else this.#counts.set(key, left);
    }
    this.#prompts.delete(id);
  }
}
