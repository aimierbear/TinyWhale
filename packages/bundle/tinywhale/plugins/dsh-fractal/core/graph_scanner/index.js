#!/usr/bin/env node
/**
 * [INPUT]: --project <path> --context <path> [--incremental] [--canvas]
 * [OUTPUT]: dependency-index.json, 可选 dependency-graph.canvas
 * [POS]: 分形系统的依赖图谱扫描器，支持全量/增量模式
 * [VERSION]: 3.3.0 - 结构变化摘要 + 追加队列兼容
 */

import fs from 'fs';
import path from 'path';
import * as babelParser from '@babel/parser';
import babelTraverse from '@babel/traverse';

const traverse = babelTraverse.default || babelTraverse;

// ============================================================================
// 配置
// ============================================================================

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue'];
const EXCLUDE_DIRS = [
    'node_modules', 'dist', 'build', '.git', '.hg', '.svn', '.idea', '.vscode',
    '__tests__', 'test', 'tests', 'spec',
    'coverage', '.next', '.nuxt', '.pnpm', '.turbo', 'out', '.vercel',
    '__pycache__', 'backup', 'backups', 'cache', 'memories',
    'memories_extensions', 'plans', 'plugins', 'target', 'vendor',
    'assets', 'static', 'public'
];
// Node16/NodeNext: import 路径带 .js 后缀但实际文件是 .ts
// 优先级：.ts 先于 .tsx（与 TypeScript 编译器行为一致）
// 注意：.mts/.cts 当前不在 CODE_EXTENSIONS 索引范围内，remap 仅在文件实际存在时生效
const EXT_REMAP = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const DIRTY_FILES_NAME = '.dirty-graph-files';
const DIRTY_OFFSET_NAME = '.dirty-graph-files.offset';
const SCAN_LOCK_NAME = '.dependency-index.scanner.lock';
const DARWIN_O_EXLOCK = 0x00000020;

const INDEX_SCHEMA = 'dependency-index';
const INDEX_VERSION = '3.3.0';
const SCAN_RESULT_SCHEMA = 'dependency-scan-result';
const SCAN_RESULT_VERSION = 1;

function assertRegularStateFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    const metadata = fs.lstatSync(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('unsafe graph state file');
    }
}

function ensureSafeContextDirectory(contextDir) {
    if (!fs.existsSync(contextDir)) {
        fs.mkdirSync(contextDir, { recursive: true, mode: 0o700 });
    }
    const metadata = fs.lstatSync(contextDir);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('unsafe graph context directory');
    }
}

function acquireScanLock(contextDir, timeoutMs = 5000) {
    ensureSafeContextDirectory(contextDir);
    if (process.platform !== 'darwin') {
        throw new Error('kernel-backed graph scan lock is unavailable');
    }
    const lockPath = path.join(contextDir, SCAN_LOCK_NAME);
    const deadline = Date.now() + timeoutMs;
    while (true) {
        try {
            const descriptor = fs.openSync(
                lockPath,
                fs.constants.O_RDWR
                    | fs.constants.O_CREAT
                    | fs.constants.O_NOFOLLOW
                    | fs.constants.O_NONBLOCK
                    | DARWIN_O_EXLOCK,
                0o600
            );
            const metadata = fs.fstatSync(descriptor);
            if (!metadata.isFile()) {
                fs.closeSync(descriptor);
                throw new Error('unsafe graph scan lock');
            }
            return () => {
                fs.closeSync(descriptor);
            };
        } catch (error) {
            if (!['EAGAIN', 'EWOULDBLOCK'].includes(error?.code) || Date.now() >= deadline) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    }
}

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

function isCodeFile(p) {
    const filePath = normalizePath(p);
    return CODE_EXTENSIONS.some(ext => filePath.endsWith(ext));
}

function isExcludedCodePath(p) {
    const parts = normalizePath(p).split('/').filter(Boolean);
    return parts.some(part => EXCLUDE_DIRS.includes(part));
}

function isGraphCodePath(p) {
    return isCodeFile(p) && !isExcludedCodePath(p);
}

function uniqueSorted(list) {
    return [...new Set((Array.isArray(list) ? list : []).filter(Boolean))].sort();
}

function normalizeIndexEntry(entry) {
    return {
        exports: uniqueSorted(entry?.exports),
        dependencies: uniqueSorted(entry?.dependencies),
        importedBy: uniqueSorted(entry?.importedBy)
    };
}

// ============================================================================
// JSONC 解析（支持注释 + 尾逗号）
// ============================================================================

function stripJsonCommentsAndTrailingCommas(input) {
    const text = String(input || '');

    // 1) 去注释（避免误伤字符串内容）
    let out = '';
    let inString = false;
    let stringChar = '';
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];

        if (inLineComment) {
            if (c === '\n') {
                inLineComment = false;
                out += c;
            }
            continue;
        }

        if (inBlockComment) {
            if (c === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (inString) {
            out += c;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (c === '\\') {
                escaped = true;
                continue;
            }
            if (c === stringChar) {
                inString = false;
                stringChar = '';
            }
            continue;
        }

        if (c === '"' || c === "'") {
            inString = true;
            stringChar = c;
            out += c;
            continue;
        }

        if (c === '/' && next === '/') {
            inLineComment = true;
            i++;
            continue;
        }

        if (c === '/' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
        }

        out += c;
    }

    // 2) 去尾逗号（仅在非字符串上下文）
    let result = '';
    inString = false;
    stringChar = '';
    escaped = false;

    for (let i = 0; i < out.length; i++) {
        const c = out[i];

        if (inString) {
            result += c;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (c === '\\') {
                escaped = true;
                continue;
            }
            if (c === stringChar) {
                inString = false;
                stringChar = '';
            }
            continue;
        }

        if (c === '"' || c === "'") {
            inString = true;
            stringChar = c;
            result += c;
            continue;
        }

        if (c === ',') {
            let j = i + 1;
            while (j < out.length && /\s/.test(out[j])) j++;
            const nextNonWs = out[j];
            if (nextNonWs === '}' || nextNonWs === ']') {
                continue; // 跳过尾逗号
            }
        }

        result += c;
    }

    return result;
}

function parseJsonc(input) {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(input));
}

// ============================================================================
// AST 解析（修复版：支持 Vue SFC + require()）
// ============================================================================

function parseImports(filePath) {
    let code = fs.readFileSync(filePath, 'utf-8');
    const imports = [];
    const exports = [];

    // Vue SFC：提取所有 <script> 块（包括 <script setup>）
    if (filePath.endsWith('.vue')) {
        const scriptMatches = code.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g);
        const scripts = [...scriptMatches].map(m => m[1]).join('\n');
        if (!scripts) return { imports: [], exports: [] };
        code = scripts;
    }

    try {
        const ast = babelParser.parse(code, {
            sourceType: 'module',
            plugins: [
                'typescript',
                'jsx',
                'decorators-legacy',
                'classProperties',
                'dynamicImport',
                'exportDefaultFrom'
            ]
        });

        traverse(ast, {
            ImportDeclaration(nodePath) {
                imports.push({
                    source: nodePath.node.source.value,
                    type: nodePath.node.importKind === 'type' ? 'type' : 'static',
                    line: nodePath.node.loc?.start.line
                });
            },
            ExportNamedDeclaration(nodePath) {
                if (nodePath.node.source) {
                    imports.push({
                        source: nodePath.node.source.value,
                        type: 're-export',
                        line: nodePath.node.loc?.start.line
                    });
                }
                const decl = nodePath.node.declaration;
                if (decl) {
                    // export function foo() / export class Foo
                    if (decl.id) {
                        exports.push(decl.id.name);
                    }
                    // export const foo = ... / export const { a, b } = ...
                    if (decl.declarations) {
                        decl.declarations.forEach(d => {
                            if (d.id?.type === 'Identifier') {
                                exports.push(d.id.name);
                            } else if (d.id?.type === 'ObjectPattern') {
                                // 解构导出: export const { a, b } = obj
                                d.id.properties?.forEach(p => {
                                    if (p.value?.name) exports.push(p.value.name);
                                });
                            }
                        });
                    }
                }
                nodePath.node.specifiers?.forEach(s => {
                    if (s.exported?.name) exports.push(s.exported.name);
                });
            },
            ExportDefaultDeclaration() {
                exports.push('default');
            },
            ExportAllDeclaration(nodePath) {
                imports.push({
                    source: nodePath.node.source.value,
                    type: 're-export-all',
                    line: nodePath.node.loc?.start.line
                });
            },
            CallExpression(nodePath) {
                // 动态 import()
                if (nodePath.node.callee.type === 'Import') {
                    const arg = nodePath.node.arguments[0];
                    if (arg?.type === 'StringLiteral') {
                        imports.push({
                            source: arg.value,
                            type: 'dynamic',
                            line: nodePath.node.loc?.start.line
                        });
                    }
                }
                // CommonJS require()
                if (nodePath.node.callee.name === 'require') {
                    const arg = nodePath.node.arguments[0];
                    if (arg?.type === 'StringLiteral') {
                        imports.push({
                            source: arg.value,
                            type: 'require',
                            line: nodePath.node.loc?.start.line
                        });
                    }
                }
            }
        });
    } catch (e) {
        // 解析失败，静默跳过
    }

    return { imports, exports };
}

// ============================================================================
// 路径解析（修复版：支持 tsconfig extends）
// ============================================================================

function loadAliases(projectRoot) {
    const aliases = {};

    function loadTsConfig(configPath, depth = 0) {
        if (depth > 5 || !fs.existsSync(configPath)) return;

        try {
            const content = fs.readFileSync(configPath, 'utf-8');
            const config = parseJsonc(content);

            // 递归加载 extends（先加载父配置，子配置覆盖）
            if (config.extends) {
                let extendPath;
                if (config.extends.startsWith('.')) {
                    // 相对路径
                    extendPath = path.resolve(path.dirname(configPath), config.extends);
                } else {
                    // 包路径（如 @tsconfig/node18）
                    extendPath = path.join(projectRoot, 'node_modules', config.extends);
                    // 如果是目录，追加 tsconfig.json
                    if (fs.existsSync(extendPath) && fs.statSync(extendPath).isDirectory()) {
                        extendPath = path.join(extendPath, 'tsconfig.json');
                    }
                }
                loadTsConfig(extendPath, depth + 1);
            }

            // 当前配置覆盖父配置
            const paths = config.compilerOptions?.paths || {};
            const baseUrl = config.compilerOptions?.baseUrl || '.';
            const configDir = path.dirname(configPath);

            for (const [alias, targets] of Object.entries(paths)) {
                const target = targets[0];
                aliases[alias.replace('/*', '')] = path.resolve(
                    configDir,
                    baseUrl,
                    target.replace('/*', '')
                );
            }
        } catch (e) { /* 忽略解析错误 */ }
    }

    loadTsConfig(path.join(projectRoot, 'tsconfig.json'));

    // 转为相对于 projectRoot 的路径
    for (const [alias, target] of Object.entries(aliases)) {
        aliases[alias] = path.relative(projectRoot, target);
    }

    return aliases;
}

function resolvePath(importSource, fromFile, projectRoot, aliases) {
    // 跳过外部包
    if (!importSource.startsWith('.') && !importSource.startsWith('@/') && !importSource.startsWith('#')) {
        let isAlias = false;
        for (const alias of Object.keys(aliases)) {
            if (importSource.startsWith(alias)) {
                isAlias = true;
                break;
            }
        }
        if (!isAlias) return null;
    }

    let resolved = importSource;

    // 处理别名（按长度降序排列，优先匹配更长的别名）
    // 例如: @/components 应优先于 @ 匹配
    const sortedAliases = Object.entries(aliases)
        .sort((a, b) => b[0].length - a[0].length);

    for (const [alias, target] of sortedAliases) {
        if (importSource.startsWith(alias)) {
            resolved = importSource.replace(alias, target);
            break;
        }
    }

    // 相对路径
    if (resolved.startsWith('.')) {
        resolved = path.join(path.dirname(fromFile), resolved);
    }

    // 转为相对于项目根的路径
    if (path.isAbsolute(resolved)) {
        resolved = path.relative(projectRoot, resolved);
    }

    const absPath = path.join(projectRoot, resolved);

    // 尝试解析：精确匹配 → 加扩展名 → index 文件
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        return resolved;
    }

    // Node16/NodeNext 扩展名重映射（常量定义在模块顶部 EXT_REMAP）
    const remapExt = path.extname(resolved);
    if (EXT_REMAP[remapExt]) {
        const base = absPath.slice(0, -remapExt.length);
        for (const newExt of EXT_REMAP[remapExt]) {
            if (fs.existsSync(base + newExt)) {
                return resolved.slice(0, -remapExt.length) + newExt;
            }
        }
    }

    for (const ext of CODE_EXTENSIONS) {
        if (fs.existsSync(absPath + ext)) {
            return resolved + ext;
        }
    }

    if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
        for (const ext of CODE_EXTENSIONS) {
            const indexPath = path.join(absPath, 'index' + ext);
            if (fs.existsSync(indexPath)) {
                return path.join(resolved, 'index' + ext);
            }
        }
    }

    return null;
}

// ============================================================================
// 文件扫描
// ============================================================================

function findCodeFiles(dir) {
    const results = [];

    function walk(currentDir) {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (e) {
            return;
        }

        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;

            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (!EXCLUDE_DIRS.includes(entry.name)) {
                    walk(fullPath);
                }
            } else if (CODE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
                results.push(fullPath);
            }
        }
    }

    walk(dir);
    results.sort();
    return results;
}

// ============================================================================
// 循环依赖检测
// ============================================================================

function detectCircularDeps(files) {
    const cycles = [];
    const visited = new Set();
    const stack = new Set();

    function dfs(file, pathStack) {
        if (stack.has(file)) {
            const cycleStart = pathStack.indexOf(file);
            if (cycleStart !== -1) {
                cycles.push(pathStack.slice(cycleStart).concat(file));
            }
            return;
        }
        if (visited.has(file)) return;

        visited.add(file);
        stack.add(file);

        const fileData = files[file];
        if (fileData) {
            for (const dep of fileData.dependencies) {
                dfs(dep, [...pathStack, file]);
            }
        }

        stack.delete(file);
    }

    for (const file of Object.keys(files)) {
        dfs(file, []);
    }

    return cycles.slice(0, 10); // 最多返回 10 个
}

// ============================================================================
// Canvas 生成
// ============================================================================

function generateCanvas(index) {
    const nodes = [];
    const edges = [];
    const fileList = Object.keys(index.files);

    // 按目录分组布局
    const dirGroups = {};
    for (const file of fileList) {
        const dir = path.posix.dirname(normalizePath(file));
        if (!dirGroups[dir]) dirGroups[dir] = [];
        dirGroups[dir].push(file);
    }

    let x = 0;
    let y = 0;
    const positions = {};

    for (const [dir, files] of Object.entries(dirGroups)) {
        for (const file of files) {
            const id = file.replace(/[^a-zA-Z0-9]/g, '_');
            positions[file] = { x, y };

            const fileData = index.files[file];
            const upCount = fileData.importedBy.length;
            const downCount = fileData.dependencies.length;

            nodes.push({
                id,
                type: 'text',
                x,
                y,
                width: 300,
                height: 60,
                text: `**${path.posix.basename(normalizePath(file))}**\n↑${upCount} ↓${downCount}`
            });

            y += 80;
        }
        x += 350;
        y = 0;
    }

    // 生成边
    for (const [file, data] of Object.entries(index.files)) {
        const fromId = file.replace(/[^a-zA-Z0-9]/g, '_');
        for (const dep of data.dependencies) {
            const toId = dep.replace(/[^a-zA-Z0-9]/g, '_');
            if (positions[dep]) {
                edges.push({
                    id: `${fromId}_to_${toId}`,
                    fromNode: fromId,
                    toNode: toId,
                    fromSide: 'right',
                    toSide: 'left'
                });
            }
        }
    }

    return { nodes, edges };
}

// ============================================================================
// 主扫描逻辑（支持全量/增量）
// ============================================================================

// 加载现有索引（兼容旧 schema）
function loadIndex(contextDir) {
    const indexPath = path.join(contextDir, 'dependency-index.json');
    if (!fs.existsSync(indexPath)) return null;
    assertRegularStateFile(indexPath);

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } catch (e) {
        return null;
    }

    if (!raw || typeof raw !== 'object') return null;

    const filesRaw = raw.files && typeof raw.files === 'object' ? raw.files : {};
    const files = {};
    for (const [filePath, data] of Object.entries(filesRaw)) {
        const relPath = normalizePath(filePath);
        if (!isGraphCodePath(relPath)) continue;
        files[relPath] = normalizeIndexEntry(data);
    }

    const version = String(raw.meta?.version || raw.version || INDEX_VERSION);

    return {
        meta: {
            schema: String(raw.meta?.schema || INDEX_SCHEMA),
            version
        },
        version,
        files,
        stats: raw.stats && typeof raw.stats === 'object' ? raw.stats : computeStats(files)
    };
}

// 原子写入索引（deterministic 输出）
function saveIndex(contextDir, index) {
    const indexPath = path.join(contextDir, 'dependency-index.json');
    assertRegularStateFile(indexPath);
    const tmpPath = `${indexPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmpPath, indexPath);
    } finally {
        try {
            fs.unlinkSync(tmpPath);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

function rebuildImportedBy(files) {
    for (const data of Object.values(files)) {
        data.importedBy = [];
    }

    for (const [file, data] of Object.entries(files)) {
        for (const dep of data.dependencies) {
            if (files[dep]) {
                files[dep].importedBy.push(file);
            }
        }
    }

    for (const [file, data] of Object.entries(files)) {
        files[file] = normalizeIndexEntry(data);
    }
}

function computeStats(files) {
    const circularDeps = detectCircularDeps(files);
    return {
        totalFiles: Object.keys(files).length,
        totalDependencies: Object.values(files).reduce((sum, f) => sum + (f.dependencies?.length || 0), 0),
        orphanFiles: Object.values(files).filter(f => (f.importedBy?.length || 0) === 0 && (f.dependencies?.length || 0) === 0).length,
        circularDeps,
        hasCircular: circularDeps.length > 0
    };
}

function finalizeIndex(files) {
    const normalizedFiles = {};
    for (const key of Object.keys(files).map(normalizePath).filter(isGraphCodePath).sort()) {
        normalizedFiles[key] = normalizeIndexEntry(files[key]);
    }

    rebuildImportedBy(normalizedFiles);

    return {
        meta: {
            schema: INDEX_SCHEMA,
            version: INDEX_VERSION
        },
        // 兼容旧字段：部分 consumer 可能仍读取顶层 version
        version: INDEX_VERSION,
        files: normalizedFiles,
        stats: computeStats(normalizedFiles)
    };
}

// ============================================================================
// Dirty 文件增量（offset 模式：不删除/不清空，只推进 offset）
// ============================================================================

function readDirtyOffset(contextDir) {
    const offsetPath = path.join(contextDir, DIRTY_OFFSET_NAME);
    if (!fs.existsSync(offsetPath)) return 0;
    assertRegularStateFile(offsetPath);
    try {
        const raw = fs.readFileSync(offsetPath, 'utf-8').trim();
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (e) {
        return 0;
    }
}

function writeDirtyOffset(contextDir, offset) {
    const offsetPath = path.join(contextDir, DIRTY_OFFSET_NAME);
    const tmpPath = `${offsetPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        assertRegularStateFile(offsetPath);
        fs.writeFileSync(tmpPath, String(Math.max(0, offset)) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmpPath, offsetPath);
    } finally {
        try {
            fs.unlinkSync(tmpPath);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

function loadDirtyDelta(contextDir) {
    const dirtyPath = path.join(contextDir, DIRTY_FILES_NAME);
    if (!fs.existsSync(dirtyPath)) {
        return { dirtyFiles: [], nextOffset: 0, totalEntries: 0, offset: 0 };
    }
    assertRegularStateFile(dirtyPath);

    let content = '';
    try {
        content = fs.readFileSync(dirtyPath, 'utf-8');
    } catch (e) {
        return { dirtyFiles: [], nextOffset: 0, totalEntries: 0, offset: 0 };
    }

    // 生产端以 O_APPEND 写入并以换行提交记录。末尾没有换行说明读取时
    // 恰逢另一进程写入，只消费已经完整提交的行，避免永久跳过半行。
    const committedContent = content.endsWith('\n') ? content : content.slice(0, content.lastIndexOf('\n') + 1);
    const entries = committedContent
        .split('\n')
        .map(line => String(line || '').trim())
        .filter(Boolean);

    const totalEntries = entries.length;
    const offset = Math.min(readDirtyOffset(contextDir), totalEntries);
    const deltaEntries = entries.slice(offset);

    const dirtyFiles = uniqueSorted(
        deltaEntries
            .map(normalizePath)
            .filter(Boolean)
            .filter(isGraphCodePath)
    );

    return {
        dirtyFiles,
        nextOffset: totalEntries,
        totalEntries,
        offset
    };
}

// 全量扫描
function fullScan(projectRoot, contextDir, generateCanvasFile = false) {
    const startTime = Date.now();

    if (!fs.existsSync(contextDir)) {
        fs.mkdirSync(contextDir, { recursive: true });
    }

    const aliases = loadAliases(projectRoot);
    const codeFiles = findCodeFiles(projectRoot);
    const files = {};

    for (const absPath of codeFiles) {
        const relPath = normalizePath(path.relative(projectRoot, absPath));
        const { imports, exports } = parseImports(absPath);
        const dependencies = uniqueSorted(
            imports
                .map(imp => resolvePath(imp.source, relPath, projectRoot, aliases))
                .filter(Boolean)
                .map(normalizePath)
                .filter(isCodeFile)
        );

        files[relPath] = {
            exports: uniqueSorted(exports),
            dependencies,
            importedBy: []
        };
    }

    const index = finalizeIndex(files);

    saveIndex(contextDir, index);

    if (generateCanvasFile) {
        const canvas = generateCanvas(index);
        fs.writeFileSync(path.join(contextDir, 'dependency-graph.canvas'), JSON.stringify(canvas, null, 2));
    }

    return {
        index,
        durationMs: Date.now() - startTime
    };
}

// 增量扫描（核心算法）
function incrementalScan(projectRoot, contextDir, dirtyFiles, generateCanvasFile = false) {
    const startTime = Date.now();
    const loaded = loadIndex(contextDir);

    if (!loaded) {
        // 无索引，回退到全量扫描
        return fullScan(projectRoot, contextDir, generateCanvasFile);
    }

    const aliases = loadAliases(projectRoot);
    let updatedCount = 0;
    let deletedCount = 0;
    const files = loaded.files || {};

    const normalizedDirtyFiles = uniqueSorted(dirtyFiles.map(normalizePath)).filter(isGraphCodePath);

    for (const dirtyFile of normalizedDirtyFiles) {
        const relPath = normalizePath(
            path.isAbsolute(dirtyFile) ? path.relative(projectRoot, dirtyFile) : dirtyFile
        );
        if (!isGraphCodePath(relPath)) continue;
        if (relPath.startsWith('..')) continue;

        const absPath = path.join(projectRoot, relPath);

        // 检查文件是否还存在
        if (!fs.existsSync(absPath)) {
            // 文件已删除：移除并清理所有出边引用
            if (files[relPath]) {
                delete files[relPath];
                for (const data of Object.values(files)) {
                    data.dependencies = (data.dependencies || []).filter(d => normalizePath(d) !== relPath);
                }
                deletedCount++;
            }
            continue;
        }

        // 文件存在：增量更新
        const { imports, exports } = parseImports(absPath);
        const newDeps = uniqueSorted(
            imports
                .map(imp => resolvePath(imp.source, relPath, projectRoot, aliases))
                .filter(Boolean)
                .map(normalizePath)
                .filter(isCodeFile)
        );

        files[relPath] = {
            exports: uniqueSorted(exports),
            dependencies: newDeps,
            importedBy: []
        };

        updatedCount++;
    }

    const index = finalizeIndex(files);

    saveIndex(contextDir, index);

    if (generateCanvasFile) {
        const canvas = generateCanvas(index);
        fs.writeFileSync(path.join(contextDir, 'dependency-graph.canvas'), JSON.stringify(canvas, null, 2));
    }

    return {
        index,
        durationMs: Date.now() - startTime,
        updated: updatedCount,
        deleted: deletedCount
    };
}

// 智能扫描（自动选择全量/增量）
function structuralChanges(beforeIndex, afterIndex) {
    const before = beforeIndex?.files || {};
    const after = afterIndex?.files || {};
    const changes = [];
    const paths = uniqueSorted([...Object.keys(before), ...Object.keys(after)]);

    for (const file of paths) {
        const previous = before[file];
        const current = after[file];
        if (!previous && current) {
            changes.push({ type: 'file_added', file });
            continue;
        }
        if (previous && !current) {
            changes.push({ type: 'file_deleted', file });
            continue;
        }
        const previousExports = uniqueSorted(previous?.exports);
        const currentExports = uniqueSorted(current?.exports);
        if (JSON.stringify(previousExports) !== JSON.stringify(currentExports)) {
            changes.push({
                type: 'exports_changed',
                file,
                before: previousExports,
                after: currentExports
            });
        }
        const previousDependencies = uniqueSorted(previous?.dependencies);
        const currentDependencies = uniqueSorted(current?.dependencies);
        if (JSON.stringify(previousDependencies) !== JSON.stringify(currentDependencies)) {
            changes.push({
                type: 'dependencies_changed',
                file,
                before: previousDependencies,
                after: currentDependencies
            });
        }
    }
    return changes;
}

function topLevelModules(index) {
    return uniqueSorted(
        Object.keys(index?.files || {})
            .map(file => normalizePath(file).split('/'))
            .filter(parts => parts.length > 1)
            .map(parts => parts[0])
    );
}

function scanSummary({ beforeIndex, result, mode, skipped, dirtyFiles }) {
    const changes = structuralChanges(beforeIndex, result.index);
    const beforeModules = topLevelModules(beforeIndex);
    const afterModules = topLevelModules(result.index);
    return {
        schema: SCAN_RESULT_SCHEMA,
        schemaVersion: SCAN_RESULT_VERSION,
        status: 'ok',
        mode,
        skipped: Boolean(skipped),
        initialized: !beforeIndex,
        dirtyFiles: uniqueSorted(dirtyFiles || []),
        structuralChanges: changes,
        affectedDirectories: uniqueSorted(changes.map(change => path.posix.dirname(change.file))),
        topLevelModulesChanged: Boolean(beforeIndex)
            && JSON.stringify(beforeModules) !== JSON.stringify(afterModules),
        // 首次建图只是建立机器基线，不应被解释为“全仓文档都已漂移”。
        requiresSemanticReview: Boolean(beforeIndex) && changes.length > 0,
        stats: result.index.stats,
        durationMs: Number(result.durationMs || 0)
    };
}

function smartScan(projectRoot, contextDir, generateCanvasFile = false) {
    const existingIndex = loadIndex(contextDir);
    const dirtyState = loadDirtyDelta(contextDir);

    // 先检查是否有索引，无索引时直接全量扫描（不需要读取脏文件）
    if (!existingIndex) {
        const result = fullScan(projectRoot, contextDir, generateCanvasFile);
        // full scan 成功后推进 offset，避免后续重复扫描历史 dirty 记录
        writeDirtyOffset(contextDir, dirtyState.nextOffset);
        return {
            skipped: false,
            mode: 'full',
            dirtyFiles: dirtyState.dirtyFiles,
            summary: scanSummary({
                beforeIndex: null,
                result,
                mode: 'full',
                skipped: false,
                dirtyFiles: dirtyState.dirtyFiles
            }),
            ...result
        };
    }

    // 有索引时，仅处理 offset 之后新增的 dirty 记录
    const dirtyFiles = dirtyState.dirtyFiles;

    if (dirtyFiles.length === 0) {
        // 无脏文件，跳过扫描
        const result = { index: existingIndex, durationMs: 0 };
        return {
            skipped: true,
            mode: 'skipped',
            dirtyFiles: [],
            summary: scanSummary({
                beforeIndex: existingIndex,
                result,
                mode: 'skipped',
                skipped: true,
                dirtyFiles: []
            }),
            ...result
        };
    }

    // 有脏文件，增量扫描
    const result = incrementalScan(projectRoot, contextDir, dirtyFiles, generateCanvasFile);
    writeDirtyOffset(contextDir, dirtyState.nextOffset);
    return {
        skipped: false,
        mode: 'incremental',
        dirtyFiles,
        summary: scanSummary({
            beforeIndex: existingIndex,
            result,
            mode: 'incremental',
            skipped: false,
            dirtyFiles
        }),
        ...result
    };
}

// ============================================================================
// 查询功能
// ============================================================================

function query(projectRoot, contextDir, filePath, depth = 1) {
    const index = loadIndex(contextDir);
    if (!index) {
        return { error: 'Index not found. Run scan first.' };
    }

    const filesDict = index.files || {};
    const fileKeys = Object.keys(filesDict);

    let queryPath = normalizePath(filePath);
    if (path.isAbsolute(queryPath)) {
        const rel = normalizePath(path.relative(projectRoot, queryPath));
        if (!rel.startsWith('..')) queryPath = rel;
    }

    let resolvedPath = filesDict[queryPath] ? queryPath : null;

    if (!resolvedPath) {
        const queryBasename = path.posix.basename(queryPath);

        // 1) basename 精确匹配
        const basenameMatches = fileKeys.filter(f => path.posix.basename(f) === queryBasename);
        if (basenameMatches.length === 1) {
            resolvedPath = basenameMatches[0];
        } else if (basenameMatches.length > 1) {
            // 2) 后缀匹配（更精确）
            const suffixMatches = basenameMatches.filter(f => f.endsWith(queryPath));
            if (suffixMatches.length === 1) {
                resolvedPath = suffixMatches[0];
            } else {
                return {
                    error:
                        `Found multiple matches. Use a longer path:\n` +
                        basenameMatches.slice(0, 10).map(f => `  - ${f}`).join('\n')
                };
            }
        } else {
            // 3) 兜底：路径后缀匹配
            const suffixMatches = fileKeys.filter(f => f.endsWith(queryPath) || f.endsWith('/' + queryPath));
            if (suffixMatches.length === 1) {
                resolvedPath = suffixMatches[0];
            } else if (suffixMatches.length > 1) {
                return {
                    error:
                        `Found multiple matches. Use a longer path:\n` +
                        suffixMatches.slice(0, 10).map(f => `  - ${f}`).join('\n')
                };
            } else {
                return { error: `File not found: ${filePath}` };
            }
        }
    }

    const fileData = filesDict[resolvedPath];
    if (!fileData) {
        return { error: `File not found: ${filePath}` };
    }

    // BFS 遍历（用指针避免 shift 的 O(n^2)）
    function traverse(startFile, direction, maxDepth) {
        const result = [];
        const visited = new Set();
        const queue = [{ file: startFile, depth: 0 }];
        let i = 0;

        while (i < queue.length) {
            const { file, depth: d } = queue[i++];
            if (d > maxDepth) continue;
            if (visited.has(file)) continue;
            if (file !== startFile) {
                visited.add(file);
                result.push({ file, depth: d });
            }

            const data = filesDict[file];
            if (!data) continue;

            const nextFiles = direction === 'up' ? data.importedBy : data.dependencies;
            for (const next of nextFiles) {
                if (!visited.has(next)) {
                    queue.push({ file: next, depth: d + 1 });
                }
            }
        }

        return result;
    }

    return {
        file: resolvedPath,
        exports: fileData.exports,
        upstream: traverse(resolvedPath, 'up', depth),     // 谁依赖我
        downstream: traverse(resolvedPath, 'down', depth)  // 我依赖谁
    };
}

// ============================================================================
// CLI
// ============================================================================

function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    const getArg = (name) => {
        const idx = args.indexOf(`--${name}`);
        return idx !== -1 ? args[idx + 1] : null;
    };
    const getArgs = (name) => args.reduce((values, item, index) => {
        if (item === `--${name}` && typeof args[index + 1] === 'string') {
            values.push(args[index + 1]);
        }
        return values;
    }, []);

    const projectRoot = getArg('project') || process.cwd();
    const contextDir = getArg('context') || path.join(projectRoot, '.context');

    switch (command) {
        case 'scan': {
            const withCanvas = args.includes('--canvas');
            const forceFull = args.includes('--full');
            const jsonOutput = args.includes('--json');
            const explicitFiles = uniqueSorted(getArgs('file').map(normalizePath))
                .filter(isGraphCodePath);
            const releaseScanLock = acquireScanLock(contextDir);

            try {
              if (forceFull) {
                const beforeIndex = loadIndex(contextDir);
                const dirtyState = loadDirtyDelta(contextDir);
                if (!jsonOutput) console.log(`Full scanning ${projectRoot}...`);
                const result = fullScan(projectRoot, contextDir, withCanvas);
                writeDirtyOffset(contextDir, dirtyState.nextOffset);
                const summary = scanSummary({
                    beforeIndex,
                    result,
                    mode: 'full',
                    skipped: false,
                    dirtyFiles: dirtyState.dirtyFiles
                });
                if (jsonOutput) {
                    console.log(JSON.stringify(summary));
                } else {
                    console.log(`✓ Full: ${result.index.stats.totalFiles} files | ${result.index.stats.totalDependencies} deps | ${result.durationMs}ms`);
                }
              } else if (explicitFiles.length > 0) {
                const beforeIndex = loadIndex(contextDir);
                const result = beforeIndex
                    ? incrementalScan(projectRoot, contextDir, explicitFiles, withCanvas)
                    : fullScan(projectRoot, contextDir, withCanvas);
                const mode = beforeIndex ? 'incremental' : 'full';
                const summary = scanSummary({
                    beforeIndex,
                    result,
                    mode,
                    skipped: false,
                    dirtyFiles: explicitFiles
                });
                if (jsonOutput) {
                    console.log(JSON.stringify(summary));
                } else if (mode === 'incremental') {
                    console.log(`✓ Explicit incremental: ${result.updated} updated, ${result.deleted} deleted | ${result.durationMs}ms`);
                } else {
                    console.log(`✓ Explicit full: ${result.index.stats.totalFiles} files | ${result.durationMs}ms`);
                }
              } else {
                // 默认智能扫描（自动选择增量/全量）
                const { skipped, mode, index, durationMs, updated, deleted, summary } = smartScan(projectRoot, contextDir, withCanvas);
                if (jsonOutput) {
                    console.log(JSON.stringify(summary));
                } else if (skipped) {
                    console.log(`✓ No changes, skipped (${index.stats.totalFiles} files indexed)`);
                } else if (mode === 'incremental') {
                    console.log(`✓ Incremental: ${updated} updated, ${deleted} deleted | ${durationMs}ms`);
                } else {
                    console.log(`✓ Full: ${index.stats.totalFiles} files | ${index.stats.totalDependencies} deps | ${durationMs}ms`);
                }
                if (index.stats.hasCircular) {
                    const warning = `⚠️  Circular: ${index.stats.circularDeps.length}`;
                    if (jsonOutput) {
                        console.error(warning);
                    } else {
                        console.log(warning);
                    }
                }
              }
            } finally {
                releaseScanLock();
            }
            break;
        }

        case 'query': {
            const file = getArg('file');
            const depth = parseInt(getArg('depth')) || 1;
            const jsonOutput = args.includes('--json');
            if (!file) {
                console.error('Usage: graph-scanner query --file <path>');
                process.exit(1);
            }
            const result = query(projectRoot, contextDir, file, depth);
            if (result.error) {
                if (jsonOutput) {
                    console.log(JSON.stringify({ status: 'error', error: result.error }));
                } else {
                    console.error(result.error);
                }
                process.exit(1);
            }
            if (jsonOutput) {
                console.log(JSON.stringify({ status: 'ok', ...result }));
                break;
            }
            console.log(`\n${result.file}`);
            console.log('─'.repeat(50));
            if (result.upstream.length > 0) {
                console.log('\n↑ Imported by:');
                result.upstream.forEach(u => console.log(`  ${'  '.repeat(u.depth - 1)}└─ ${u.file}`));
            }
            if (result.downstream.length > 0) {
                console.log('\n↓ Imports:');
                result.downstream.forEach(d => console.log(`  ${'  '.repeat(d.depth - 1)}└─ ${d.file}`));
            }
            break;
        }

        case 'stats': {
            const index = loadIndex(contextDir);
            if (!index) {
                console.log('No index found. Run scan first.');
                break;
            }
            console.log(`📊 ${index.stats.totalFiles} files | ${index.stats.totalDependencies} deps`);
            console.log(`   Orphans: ${index.stats.orphanFiles}`);
            console.log(`   Circular: ${index.stats.hasCircular ? '⚠️ Yes' : '✓ None'}`);
            console.log(`   Schema: ${index.meta?.schema || 'unknown'}`);
            console.log(`   Version: ${index.meta?.version || index.version || 'unknown'}`);
            break;
        }

        case 'canvas': {
            const index = loadIndex(contextDir);
            if (!index) {
                console.error('Index not found. Run scan first.');
                process.exit(1);
            }
            const canvas = generateCanvas(index);
            const outputPath = getArg('output') || path.join(contextDir, 'dependency-graph.canvas');
            fs.writeFileSync(outputPath, JSON.stringify(canvas, null, 2));
            console.log(`✓ Canvas saved to ${outputPath}`);
            break;
        }

        case 'dirty': {
            const dirtyState = loadDirtyDelta(contextDir);
            if (dirtyState.totalEntries === 0) {
                console.log('No dirty files.');
                break;
            }

            console.log(`Dirty entries: ${dirtyState.totalEntries} (offset: ${dirtyState.offset})`);
            if (dirtyState.dirtyFiles.length === 0) {
                console.log('No pending dirty files.');
            } else {
                console.log(`Pending files (${dirtyState.dirtyFiles.length}):`);
                dirtyState.dirtyFiles.forEach(f => console.log(`  ${f}`));
            }
            break;
        }

        default:
            console.log(`
graph-scanner v3.3 - 依赖图谱扫描器（deterministic + 结构变化摘要）

Commands:
  scan      智能扫描 [--full 强制全量] [--file <path> 可重复] [--canvas] [--json]
  query     查询依赖 --file <path> [--depth 2] [--json]
  stats     显示统计
  canvas    生成可视化 [--output <path>]
  dirty     显示待扫描文件（调试）

Options:
  --project   项目根目录（默认当前目录）
  --context   输出目录（默认 .context）
`);
    }
}

main();
