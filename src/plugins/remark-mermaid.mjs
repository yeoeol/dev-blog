// ```mermaid 코드블록을 <pre class="mermaid"> 로 바꿔서
// 코드 하이라이터를 거치지 않고 브라우저에서 mermaid 가 다이어그램으로 렌더링하게 한다.

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function replaceMermaidBlocks(node) {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    if (child.type === 'code' && child.lang === 'mermaid') {
      return { type: 'html', value: `<pre class="mermaid">${escapeHtml(child.value)}</pre>` };
    }
    replaceMermaidBlocks(child);
    return child;
  });
}

export function remarkMermaid() {
  return (tree) => replaceMermaidBlocks(tree);
}
