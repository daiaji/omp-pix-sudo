{
  description = "omp-pix-sudo — sudo_run tool for omp (port of @xynogen/pix-sudo)";

  # 打包哲学：插件是 omp 运行时加载的纯 TS 源码目录，本 flake 只负责把「运行
  # 所需的最小闭包」放进 store——src + package.json + LICENSE。不做任何编译/
  # 依赖安装：omp 自带的 bun 直接跑 TS。「用 omp 二进制真加载」的门禁放在
  # nixos_data 的 checks 里（那边有 llm-agents 输入），本仓库不把几百 MB 的
  # omp 拉进自己的闭包。

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll =
        f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});

      # SSOT：版本号只存在于 package.json，flake 不得手抄第二份。
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

      # 运行闭包：只带 omp 加载时真正读的文件。git-src/test/scripts/REFACTOR.md
      # 都是开发资料，不进 store。
      runtimeSrc =
        pkgs:
        pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./src
            ./package.json
            ./LICENSE
          ];
        };
    in
    {
      packages = forAll (
        pkgs:
        let
          src = runtimeSrc pkgs;
        in
        {
          omp-pix-sudo = pkgs.stdenv.mkDerivation {
            pname = "omp-pix-sudo";
            inherit version src;

            # 纯 TS：无 configure/build 步骤，直接铺文件。
            dontConfigure = true;
            dontBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/omp-pix-sudo
              cp -r src package.json LICENSE $out/share/omp-pix-sudo/
              runHook postInstall
            '';

            meta = {
              description = "sudo_run tool for omp — interactive PAM password gate over sudo -S (port of @xynogen/pix-sudo)";
              license = pkgs.lib.licenses.mit;
              platforms = pkgs.lib.platforms.unix;
            };
          };

          default = self.packages.${pkgs.stdenv.hostPlatform.system}.omp-pix-sudo;
        }
      );

      # devShell bun-only：类型检查 `bunx tsc --noEmit`，测试 `bun test`。
      # 不带 node——omp 运行时是 bun，双运行时只会制造「本机能跑 CI 不能跑」
      # 的漂移。typescript 由 package.json devDeps 精确 pin，bunx 现取。
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            typescript
          ];
        };
      });
    };
}
