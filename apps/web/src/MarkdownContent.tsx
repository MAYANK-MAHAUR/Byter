import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export function MarkdownContent({ value, className }: { value: string; className?: string }) {
  return (
    <div className={["markdown-content", className].filter(Boolean).join(" ")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml>
        {value}
      </ReactMarkdown>
    </div>
  );
}
