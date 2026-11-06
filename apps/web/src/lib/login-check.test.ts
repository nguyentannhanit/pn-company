/**
 * P&N — Kiểm tra ô nhập trang đăng nhập: đúng ô bị chỉ, đúng thứ tự, đúng loại lỗi máy chủ.
 */

import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { checkLoginInput, loginFailureKind, wrongPasswordLine } from './login-check';

describe('checkLoginInput', () => {
  const ok = { email: 'ceo@pn.company', password: 'mat-khau-dai', bootstrap: false };

  it('nhận email và mật khẩu hợp lệ', () => {
    expect(checkLoginInput(ok)).toBeNull();
  });

  it('chỉ vào ô email khi bỏ trống hoặc sai dạng', () => {
    expect(checkLoginInput({ ...ok, email: '  ' })?.field).toBe('email');
    expect(checkLoginInput({ ...ok, email: 'ceopn.company' })?.message).toContain('chưa đúng dạng');
  });

  it('chỉ vào ô mật khẩu khi bỏ trống', () => {
    expect(checkLoginInput({ ...ok, password: '' })?.field).toBe('password');
  });

  it('báo ô trên cùng trước khi nhiều ô cùng thiếu', () => {
    expect(checkLoginInput({ email: '', password: '', bootstrap: false })?.field).toBe('email');
    expect(checkLoginInput({ email: '', password: '', displayName: '', bootstrap: true })?.field).toBe('name');
  });

  it('chỉ đòi tên hiển thị khi tạo tài khoản CEO đầu tiên', () => {
    expect(checkLoginInput({ ...ok, bootstrap: true })?.field).toBe('name');
    expect(checkLoginInput({ ...ok, displayName: 'Anh', bootstrap: true })).toBeNull();
  });

  it('chặn mật khẩu dưới 8 ký tự ở cả hai chế độ (máy chủ không nhận, và trả câu tiếng Anh)', () => {
    expect(checkLoginInput({ ...ok, password: 'ngan' })?.message).toContain('ít nhất 8');
    expect(checkLoginInput({ ...ok, password: 'ngan', displayName: 'Anh', bootstrap: true })?.message).toContain('tối thiểu 8');
    expect(checkLoginInput({ ...ok, password: '12345678' })).toBeNull();
  });
});

describe('loginFailureKind', () => {
  it('401 là sai email hoặc mật khẩu', () => {
    expect(loginFailureKind(new ApiError(401, 'Email hoặc mật khẩu không đúng'))).toBe('wrong');
  });

  it('fetch không tới máy chủ là mất kết nối, không phải lỗi người dùng', () => {
    expect(loginFailureKind(new TypeError('Failed to fetch'))).toBe('offline');
  });

  it('lỗi khác của máy chủ không bị coi là sai mật khẩu', () => {
    expect(loginFailureKind(new ApiError(500, 'Lỗi máy chủ'))).toBe('other');
  });
});

describe('wrongPasswordLine', () => {
  it('lần thứ 3 chỉ cách lấy link qua Telegram', () => {
    expect(wrongPasswordLine(1)).not.toContain('/dashboard');
    expect(wrongPasswordLine(2)).toContain('Caps Lock');
    expect(wrongPasswordLine(3)).toContain('/dashboard');
  });
});
