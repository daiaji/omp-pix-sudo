# omp-pix-sudo 开发配方。默认目标 = 类型门禁 + 注册测试 + 生成器一致性。

# 类型检查：devDeps 里的 @oh-my-pi/* 与宿主 omp 版本严格一致（19.1.1），
# tsconfig 的 paths 把上游 @earendil-works/* 命名空间映射到 canonical 包。
check-types:
	bunx tsc --noEmit

# 注册测试：stub pi 装载 src/index.ts，断言 sudo_run 的注册契约。
# 这是模型无关的加载检查，比真二进制 print 模式稳定（沙箱静默 exit 0 陷阱）。
test:
	bun test

# 生成器一致性：src/ 必须恰好是 scripts/port 从 git-src/ 派生的结果。
port-check:
	./scripts/port --check

# 上游参考树同步：重新下载 upstream.json 锁定的 tarball、校验 sha256、
# 解包进 git-src/。--check 只校验不写入。
sync:
	./scripts/sync-upstream

# 升级上游三步走：改 upstream.json → just sync → just port（然后 review diff）。
port:
	./scripts/port

# 全量门禁（本仓库 CI 等价物）。真·加载检查在 nixos_data 的
# checks.omp-pix-sudo-load（那边有 llm-agents 输入，本仓库不拉几百 MB 的 omp）。
verify: check-types test port-check
	@echo "✅ omp-pix-sudo verify 通过"
