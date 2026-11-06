/**
 * P&N — Triển khai (§38, §62).
 *
 * Điểm quan trọng của màn hình này không phải nút bấm mà là cổng kiểm soát:
 * deploy production luôn tạo yêu cầu phê duyệt trước, không bao giờ chạy thẳng.
 * Mỗi dự án hiện kèm bản staging mới nhất để CEO mở sản phẩm ngay tại đây.
 *
 * Nay bản thử dựng thành công có khung xem thu nhỏ chạy thật (không phải
 * ảnh chụp): nhìn là biết sản phẩm ra hình gì trước khi bấm mở.
 */

'use client';

import { useEffect, useState } from 'react';

import { Badge, Button, Empty, ErrorNote, PageHeader, Section, Skeleton } from '@/components/ui';
import { api, apiUrl, type ProjectRow } from '@/lib/api';
import { PRODUCT_TYPE_LABEL } from '@/lib/brand';
import { useRealtime } from '@/lib/store';

interface DeploymentRow {
  id: string;
  projectId: string;
  environment: string;
  status: string;
  url: string | null;
  commitSha: string | null;
  createdAt: string;
}

/**
 * Khung xem thu nhỏ: trang sản phẩm thật thu nhỏ 1/5, không bấm được bên trong
 * (bấm là mở tab mới). Vé xem xin lúc hiện, giống nút "Mở sản phẩm".
 */
function ProductThumb({ projectId, onOpen }: { projectId: string; onOpen: () => void }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<{ url: string }>(`/projects/${projectId}/product-link`)
      // Vé xem gắn với địa chỉ API mà dashboard đang dùng: cookie xem sản phẩm
      // chỉ theo được khung thu nhỏ khi khung và API cùng một nơi.
      .then((result) => {
        const link = new URL(result.url);
        const base = new URL(apiUrl());
        setUrl(`${base.origin}${link.pathname}${link.search}`);
      })
      .catch(() => setFailed(true));
  }, [projectId]);
  return (
    <button type="button" onClick={onOpen} className="pn-thumb pn-focus" title="Mở sản phẩm ở tab mới" aria-label="Mở sản phẩm">
      {url && !failed ? (
        <iframe src={url} title="Xem trước sản phẩm" loading="lazy" tabIndex={-1} sandbox="allow-scripts allow-same-origin" />
      ) : (
        <span>{failed ? 'Không tải được' : 'Đang tải…'}</span>
      )}
    </button>
  );
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'var(--tone-gray)',
  AWAITING_APPROVAL: 'var(--tone-amber)',
  IN_PROGRESS: 'var(--tone-blue)',
  SUCCESS: 'var(--tone-teal)',
  FAILED: 'var(--tone-red)',
  ROLLED_BACK: 'var(--tone-orange)',
  CANCELLED: 'var(--tone-dim)',
};
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Chờ',
  AWAITING_APPROVAL: 'Chờ duyệt',
  IN_PROGRESS: 'Đang chạy',
  SUCCESS: 'Thành công',
  FAILED: 'Thất bại',
  ROLLED_BACK: 'Đã lùi',
  CANCELLED: 'Đã dừng',
};

export default function DeployPage(): React.JSX.Element {
  const { lastEventAt } = useRealtime();
  const [deployments, setDeployments] = useState<DeploymentRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api<{ deployments: DeploymentRow[] }>('/deployments'), api<{ projects: ProjectRow[] }>('/projects')])
      .then(([deployResult, projectResult]) => {
        setDeployments(deployResult.deployments.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        setProjects(projectResult.projects);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Không tải được dữ liệu triển khai'));
  }, [lastEventAt]);

  const openProduct = async (projectId: string): Promise<void> => {
    try {
      const { url } = await api<{ url: string }>(`/projects/${projectId}/product-link`);
      window.open(url, '_blank', 'noopener');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không mở được sản phẩm');
    }
  };

  const deploy = async (projectId: string, environment: 'STAGING' | 'PRODUCTION'): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(`${projectId}:${environment}`);
    try {
      const result = await api<{ status?: string; message?: string }>('/deployments', {
        method: 'POST',
        body: { projectId, environment },
      });
      setNotice(
        result.status === 'AWAITING_APPROVAL'
          ? (result.message ?? 'Đã tạo phiếu duyệt. Xem ở tab Phê duyệt hoặc Telegram.')
          : 'Đã bắt đầu dựng bản thử. Kết quả sẽ hiện ở lịch sử bên dưới.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không triển khai được');
    } finally {
      setBusy(null);
    }
  };

  /** Dừng bản thử đang dựng: cắt npm/electron-builder ngay; bấm Dựng bản thử để dựng lại từ đầu. */
  const stopBuild = async (projectId: string): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(`${projectId}:STOP`);
    try {
      await api(`/projects/${projectId}/staging/stop`, { method: 'POST', body: {} });
      setNotice('Đã dừng bản thử. Bấm Dựng bản thử khi muốn dựng lại.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không dừng được');
    } finally {
      setBusy(null);
    }
  };

  // Chỉ dự án còn sống mới có nút deploy; tên thì tra được cho cả dự án đã lưu trữ.
  const targets = projects.filter((project) => project.status !== 'ARCHIVED');
  const projectName = (id: string): string => projects.find((project) => project.id === id)?.name ?? `dự án ${id.slice(0, 8)}`;
  const latestFor = (projectId: string): DeploymentRow | undefined => deployments?.find((deployment) => deployment.projectId === projectId);

  const openLink = (deployment: DeploymentRow): React.ReactNode => {
    if (!deployment.url) return null;
    // Sản phẩm do API phục vụ cần vé xem; xin vé rồi mở tab mới.
    if (deployment.url.includes('/product/')) {
      return (
        <Button size="sm" variant="quiet" onClick={() => void openProduct(deployment.projectId)}>
          Mở sản phẩm ↗
        </Button>
      );
    }
    return (
      <a href={deployment.url} target="_blank" rel="noreferrer" className="pn-press pn-focus inline-flex h-8 items-center rounded-lg border border-line bg-fill-1 px-3 text-xs font-medium text-ink-100 hover:bg-fill-2">
        Mở ↗
      </a>
    );
  };

  return (
    <div className="pb-8">
      <PageHeader eyebrow="Đưa ra ngoài" title="Triển khai" subtitle="Bản thử tự dựng và tự kiểm. Bản chính thức luôn cần CEO duyệt trước." />
      <ErrorNote error={error} />
      {notice && <p className="mx-5 mt-4 rounded-lg border border-produce-400/25 bg-produce-600/10 px-3 py-2 text-xs text-produce-400">{notice}</p>}

      <div className="space-y-8 p-5">
        <Section title="Dự án" description="Bản thử mới nhất hiện ngay cạnh tên">
          {deployments === null && <Skeleton rows={3} />}
          {deployments !== null && targets.length === 0 && <Empty message="Chưa có dự án nào để triển khai." />}
          <div className="space-y-2">
            {targets.map((project) => {
              const latest = latestFor(project.id);
              return (
                <div key={project.id} className="depth-panel flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-1 px-4 py-3">
                  {latest?.status === 'SUCCESS' && latest.url?.includes('/product/') && (
                    <ProductThumb projectId={project.id} onOpen={() => void openProduct(project.id)} />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink-100">{project.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
                      <span>{PRODUCT_TYPE_LABEL[project.productType] ?? project.productType}</span>
                      {latest && (
                        <>
                          <span className="opacity-40">·</span>
                          <Badge color={STATUS_COLOR[latest.status]} dot>
                            {latest.environment === 'STAGING' ? 'bản thử' : 'bản chính thức'} {STATUS_LABEL[latest.status] ?? latest.status}
                          </Badge>
                          <span>{new Date(latest.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}</span>
                        </>
                      )}
                    </p>
                  </div>
                  {latest?.status === 'SUCCESS' && openLink(latest)}
                  {latest?.environment === 'STAGING' && latest.status === 'IN_PROGRESS' ? (
                    <Button size="sm" variant="danger" onClick={() => void stopBuild(project.id)} loading={busy === `${project.id}:STOP`} disabled={busy !== null}>
                      Dừng dựng
                    </Button>
                  ) : (
                    <Button size="sm" variant="quiet" onClick={() => void deploy(project.id, 'STAGING')} loading={busy === `${project.id}:STAGING`} disabled={busy !== null}>
                      Dựng bản thử
                    </Button>
                  )}
                  <Button size="sm" onClick={() => void deploy(project.id, 'PRODUCTION')} loading={busy === `${project.id}:PRODUCTION`} disabled={busy !== null} title="Tạo phiếu duyệt trước, chỉ chạy khi CEO đồng ý">
                    Bản chính thức
                  </Button>
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Lịch sử" description={deployments ? `${deployments.length} lần triển khai` : undefined}>
          {deployments?.length === 0 && <p className="text-xs text-ink-500">Chưa có lần triển khai nào.</p>}
          <div className="space-y-1.5">
            {deployments?.map((deployment, index) => (
              <div key={deployment.id} className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-line bg-surface-1 py-2.5 pl-4 pr-3 text-xs">
                <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r" style={{ background: STATUS_COLOR[deployment.status] ?? 'var(--tone-gray)' }} />
                {/* Khung xem thu nhỏ cho bản thử thành công MỚI NHẤT của mỗi dự án — không dựng hàng chục khung cho lịch sử cũ. */}
                {deployment.status === 'SUCCESS' &&
                  deployment.url?.includes('/product/') &&
                  deployments.findIndex((other) => other.projectId === deployment.projectId && other.status === 'SUCCESS') === index && (
                    <ProductThumb projectId={deployment.projectId} onOpen={() => void openProduct(deployment.projectId)} />
                  )}
                <Badge color={STATUS_COLOR[deployment.status]} dot>{STATUS_LABEL[deployment.status] ?? deployment.status}</Badge>
                <span className="text-[10px] uppercase tracking-wider text-ink-500">{deployment.environment === 'STAGING' ? 'bản thử' : 'chính thức'}</span>
                <span className="min-w-0 flex-1 truncate text-ink-300">{projectName(deployment.projectId)}</span>
                {deployment.status === 'SUCCESS' && openLink(deployment)}
                <span className="shrink-0 font-mono text-[10px] text-ink-500">{new Date(deployment.createdAt).toLocaleString('vi-VN')}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
