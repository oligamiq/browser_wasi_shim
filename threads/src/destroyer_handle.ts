/**
 * DestroyerHandle: スレッド間で送信可能な destroy オブジェクト
 *
 * 特定の WASIFarmAnimal から destroy を要求できるように設計されています。
 * SharedArrayBuffer 上のフラグのみを使用して実装します。
 *
 * - init_self: ワーカースレッドで初期化
 * - destroy: メインスレッド または 別スレッドから呼び出し可能
 * - destroyされたら自身も死ぬ（状態フラグにより識別）
 */

export interface DestroyerHandleObject {
  destroy_statuses: SharedArrayBuffer[];
}

export class DestroyerHandle {
  private destroy_statuses: SharedArrayBuffer[];
  private destroyed: boolean = false;

  constructor(destroy_statuses: SharedArrayBuffer[]) {
    this.destroy_statuses = destroy_statuses;
  }

  static init_self(obj: DestroyerHandleObject): DestroyerHandle {
    return new DestroyerHandle(obj.destroy_statuses);
  }

  get_object(): DestroyerHandleObject {
    return {
      destroy_statuses: this.destroy_statuses,
    };
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    for (const destroy_status of this.destroy_statuses) {
      const view = new Int32Array(destroy_status);
      const old_value = Atomics.compareExchange(view, 0, 0, 1);
      if (old_value === 0) {
        Atomics.notify(view, 0);
      }
    }

    this.destroyed = true;
  }

  is_destroyed(): boolean {
    return this.destroyed;
  }
}

