// 한 줄에 이미지만 있고 title 이 있는 경우 캡션이 달린 <figure> 로 바꾼다.
//   ![대체 텍스트](./image.png "캡션")
//   → <figure><img src="./image.png" alt="대체 텍스트"><figcaption>캡션</figcaption></figure>

const isWhitespace = (node) => node.type === 'text' && node.value.trim() === '';

function wrapCaptionedImages(node) {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    if (child.type === 'element' && child.tagName === 'p') {
      const content = child.children.filter((c) => !isWhitespace(c));
      const [img] = content;
      if (content.length === 1 && img.type === 'element' && img.tagName === 'img' && img.properties?.title) {
        const caption = String(img.properties.title);
        delete img.properties.title;
        return {
          type: 'element',
          tagName: 'figure',
          properties: {},
          children: [img, { type: 'element', tagName: 'figcaption', properties: {}, children: [{ type: 'text', value: caption }] }],
        };
      }
    }
    wrapCaptionedImages(child);
    return child;
  });
}

export function rehypeFigure() {
  return (tree) => wrapCaptionedImages(tree);
}
