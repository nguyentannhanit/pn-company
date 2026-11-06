/**
 * P&N — Mở sản phẩm của dự án ngay trên API (§38, §144).
 *
 * Dashboard xin một liên kết có vé xem (JWT ngắn hạn, chỉ dùng cho đúng một
 * slug); lần mở đầu tiên đổi vé thành cookie giới hạn ở `/product/`, để các
 * file css/js mà trang tự tải về cũng qua được. Không có vé thì chỉ thấy trang
 * hướng dẫn, không thấy sản phẩm — workspace là mã của khách, không công khai.
 */

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import { tunnelApiUrl } from '../services/tunnel.js';
import type { SessionPayload } from '../plugins/auth.js';
import { contentTypeFor, resolveProductArtifact, rewriteHtml, safeProductPath } from '../services/local-deploy.js';

const COOKIE = 'pn_product';
const idParam = z.object({ id: z.string().uuid() });
const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,120}$/) });

/** Link mở sản phẩm kèm vé xem 12 giờ, chỉ dùng cho đúng một slug. */
export function productViewUrl(app: FastifyInstance, context: AppContext, slug: string): string {
  const token = app.jwt.sign(
    { sub: `product:${slug}`, email: 'product@pn.local', role: 'VIEWER' },
    { expiresIn: '12h' },
  );
  return `${tunnelApiUrl() ?? context.config.publicUrl}/product/${slug}/?v=${token}`;
}

export async function productRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const root = path.resolve(context.config.sandboxRoot);

  const viewerFor = (token: string | undefined): string | null => {
    if (!token) return null;
    try {
      const payload = app.jwt.verify<SessionPayload>(token);
      return payload.sub.startsWith('product:') ? payload.sub.slice('product:'.length) : null;
    } catch {
      return null;
    }
  };

  app.get('/projects/:id/product-link', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = await context.repos.projects.findById(id);
    if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });

    return reply.send({ url: productViewUrl(app, context, project.slug) });
  });

  app.get('/product/:slug', async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
    return reply.redirect(`/product/${slug}/${query}`, 302);
  });

  app.get('/product/:slug/*', async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const { v } = z.object({ v: z.string().optional() }).parse(request.query ?? {});

    // Vé trên URL chỉ dùng một lần: đổi thành cookie rồi chuyển hướng về URL sạch.
    if (v) {
      if (viewerFor(v) !== slug) return reply.code(403).type('text/html; charset=utf-8').send(page('Vé xem không hợp lệ hoặc đã hết hạn. Mở lại từ dashboard.'));
      reply.header('set-cookie', `${COOKIE}=${v}; Path=/product/; HttpOnly; SameSite=Lax; Max-Age=43200`);
      return reply.redirect(`/product/${slug}/${(request.params as { '*': string })['*'] ?? ''}`, 302);
    }

    const cookie = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (viewerFor(cookie) !== slug) {
      return reply.code(401).type('text/html; charset=utf-8').send(page('Mở sản phẩm từ dashboard: Dự án → Mở sản phẩm.'));
    }

    const project = await context.repos.projects.findBySlug(slug);
    const artifact = await resolveProductArtifact(path.join(root, slug), project?.productType ?? 'WEB_APPLICATION');
    if (!artifact) {
      return reply.code(404).type('text/html; charset=utf-8').send(page('Dự án này chưa có bản dựng. Vào Deploy → Staging để dựng.'));
    }

    // Phần mềm desktop: trang tải + đường tải file .exe.
    if (artifact.kind === 'exe') {
      const rest = (request.params as { '*': string })['*'] ?? '';
      const name = path.basename(artifact.file);
      if (rest === 'download') {
        return reply
          .header('content-disposition', `attachment; filename="${name.replace(/"/g, '')}"`)
          .header('content-length', artifact.size)
          .type('application/octet-stream')
          .send(createReadStream(artifact.file));
      }
      return reply.type('text/html; charset=utf-8').send(downloadPage(project?.name ?? slug, name, artifact.size, `/product/${slug}/download`));
    }
    const productDir = artifact.dir;

    const relative = safeProductPath((request.params as { '*': string })['*'] ?? '');
    if (!relative) return reply.code(404).type('text/html; charset=utf-8').send(page('Không có file này.'));
    const target = path.resolve(productDir, relative);
    if (!target.startsWith(productDir + path.sep)) return reply.code(404).send(page('Không có file này.'));

    let body: Buffer;
    try {
      body = await readFile(target);
    } catch {
      return reply.code(404).type('text/html; charset=utf-8').send(page('Không có file này.'));
    }
    const extension = path.extname(target).toLowerCase();
    reply.type(contentTypeFor(extension));
    if (extension === '.html' || extension === '.htm') {
      return reply.send(rewriteHtml(body.toString('utf8'), `/product/${slug}/`));
    }
    return reply.send(body);
  });
}

/** Trang tải phần mềm desktop: tên, cỡ file, nút tải, và lời dặn về SmartScreen. */
function downloadPage(projectName: string, fileName: string, size: number, href: string): string {
  const mb = (size / 1_048_576).toFixed(1);
  return (
    '<!doctype html><meta charset="utf-8"><title>' + escapeHtml(projectName) + '</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1418;color:#d6dde3;font:15px system-ui">' +
    '<div style="max-width:30rem;padding:2rem;border:1px solid #2a343c;border-radius:14px;background:#161d23">' +
    `<h1 style="margin:0 0 .5rem;font-size:1.25rem">${escapeHtml(projectName)}</h1>` +
    `<p style="margin:0 0 1.25rem;color:#9aa8b3">${escapeHtml(fileName)} · ${mb} MB · Windows</p>` +
    `<a href="${href}" style="display:inline-block;padding:.7rem 1.2rem;border-radius:10px;background:#005eff;color:#fff;text-decoration:none;font-weight:600">Tải về</a>` +
    '<p style="margin:1.25rem 0 0;font-size:13px;color:#9aa8b3">File chưa ký số nên Windows SmartScreen có thể hỏi; chọn "Thông tin thêm → Vẫn chạy".</p>' +
    '</div></body>'
  );
}

/** Trang nhắn ngắn, cùng nền với dashboard, không lộ gì về workspace. */
function page(message: string): string {
  return (
    '<!doctype html><meta charset="utf-8"><title>P&N</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1418;color:#d6dde3;font:15px system-ui">' +
    `<p style="max-width:32rem;padding:1.5rem;border:1px solid #2a343c;border-radius:12px;background:#161d23">${escapeHtml(message)}</p></body>`
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
