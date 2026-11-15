import type { IdentityProfile } from "./source-identity";

export function sourceHealthKey(profile: IdentityProfile): string {
  return `${profile.identityProvider ?? "ima-api"}:${profile.knowledgeBaseId}:${profile.folderId ?? ""}`;
}

export function sourceProblemMessage(error: unknown, profile: IdentityProfile): string {
  const issue = error as { code?: string; sourceTarget?: string; message?: string } | undefined;
  if (issue?.code === "not-found") {
    return issue.sourceTarget === "knowledge-base" || !profile.folderId
      ? "找不到知识库，请重新选择来源。"
      : "找不到文件夹，请重新选择来源。";
  }
  if (issue?.code === "login-required") return "IMA 登录已失效，请登录后重试。";
  if (issue?.code === "network-unavailable") return "暂时无法连接 IMA，请重试。";
  if (issue?.code === "incomplete") return "目录未读取完整，请重试。";
  return issue?.message || "暂时无法核对来源，请重试。";
}
