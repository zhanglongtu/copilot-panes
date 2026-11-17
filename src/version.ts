// 版本号。构建时 build.mjs 把这个文件整个换成一行 `export const version = "x.y.z"`，所以包里没有 package.json 的任何内容；
// 直接运行源码（node src/cli.ts）和测试时才走下面的读文件。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const text = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");

export const version: string = (JSON.parse(text) as { version: string }).version;
