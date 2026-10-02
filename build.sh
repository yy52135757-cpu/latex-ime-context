#!/usr/bin/env bash
# 打包并安装 LaTeX IME Context
set -euo pipefail

cd "$(dirname "$0")"
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
VSIX="$NAME-$VERSION.vsix"
CODE_BIN=$(ls ~/.vscode-server/bin/*/bin/remote-cli/code 2>/dev/null | head -1 || true)

echo "==> 运行测试"
node test/context.test.js | tail -3
node test/trigger.test.js | tail -3
node test/smarttab.test.js | tail -3

echo "==> 打包 $VSIX"
rm -rf .build "$VSIX"
mkdir -p .build/extension
cp -r package.json extension.js src bin README.md .build/extension/

cat > .build/\[Content_Types\].xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".exe" ContentType="application/octet-stream"/>
</Types>
XML

cat > .build/extension.vsixmanifest <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$NAME" Version="$VERSION" Publisher="gryllidae"/>
    <DisplayName>LaTeX IME Context</DisplayName>
    <Description xml:space="preserve">按 LaTeX 结构自动切换输入法</Description>
    <Tags>latex,ime,input</Tags>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
XML

(cd .build && zip -qr "../$VSIX" '[Content_Types].xml' extension.vsixmanifest extension)
rm -rf .build
ls -lh "$VSIX"

echo "==> 安装"
if [ -n "$CODE_BIN" ]; then
  "$CODE_BIN" --install-extension "$PWD/$VSIX" --force
else
  echo "未找到 code CLI，请手动安装 $PWD/$VSIX"
  exit 1
fi

echo "==> 完成：请在 VS Code 里 Reload Window"
