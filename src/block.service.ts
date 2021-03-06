import {
  ApplicationRef,
  ComponentFactoryResolver,
  ComponentRef,
  EmbeddedViewRef,
  Inject,
  Injectable,
  Injector,
  Optional,
  Type,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { Block } from './model/block.interface';
import {
  BLOCK_BLOCKER_COUNT,
  BLOCK_DATA,
  BLOCK_DEFAULT_GLOBAL_COMPONENT,
  BLOCK_DEFAULT_SPECIFIED_COMPONENT,
  BLOCK_TARGET,
} from './block.provider';
import { doOnSubscribe } from './util/do-on-subscribe.util';
import { BlockComponentInjector } from './model/portal-injector.model';
import { Target } from './model/target.type';
import { BlockInput } from './model/block-input.interface';
import { ObservableBlockInput } from './model/observable-block-input.interface';
import { PromiseBlockInput } from './model/promise-block-input.interface';
import { SubscriptionBlockInput } from './model/subscription-block-input.interface';
import { TriggerBlockInput } from './model/trigger-block-input.interface';
import { Trigger } from './model/trigger.type';
import { Unblock } from './model/unblock.interface';

/**
 * This service can block specified target or the application by manual call, subscription, observable and promise.
 */
@Injectable()
export class BlockService {
  private blocks = new WeakMap<Target, Block>();

  constructor(
    private componentFactoryResolver: ComponentFactoryResolver,
    private applicationRef: ApplicationRef,
    private defaultInjector: Injector,
    @Inject(DOCUMENT) private document: any,
    @Optional()
    @Inject(BLOCK_DEFAULT_GLOBAL_COMPONENT)
    private readonly defaultGlobalComponent: Type<any>,
    @Optional()
    @Inject(BLOCK_DEFAULT_SPECIFIED_COMPONENT)
    private readonly defaultSpecifiedComponent: Type<any>
  ) {
    if (!defaultSpecifiedComponent) {
      this.defaultSpecifiedComponent = this.defaultGlobalComponent;
    }
  }

  /**
   * Block manually
   * @param config
   */
  public block<T extends Trigger>(config?: BlockInput<T>): void;
  /**
   * Block by a trigger
   * @param trigger
   * @returns trigger
   */
  public block<T extends Trigger>(trigger: T): T;
  /**
   * Block by a subscription
   * @param config
   * @returns original subscription
   */
  public block(config: SubscriptionBlockInput): Subscription;
  /**
   * Block by an observable
   * @param config
   * @returns wrapped observable
   */
  public block<T>(config: ObservableBlockInput<T>): Observable<T>;
  /**
   * Block by a promise
   * @param config
   * @returns original promise
   */
  public block<T>(config: PromiseBlockInput<T>): Promise<T>;
  public block<T extends Trigger>(config: TriggerBlockInput<T>): T;
  public block<T extends Trigger>(
    config: T | BlockInput<T> | SubscriptionBlockInput | ObservableBlockInput<T> | PromiseBlockInput<T> | TriggerBlockInput<T> = {}
  ): void | Observable<T> | Promise<T> | Subscription | T {
    // handle only trigger inputs
    if (
      this.instanceOf<Subscription>(config, 'add') ||
      this.instanceOf<Promise<any>>(config, 'then') ||
      this.instanceOf<Observable<any>>(config, 'subscribe')
    ) {
      return this.block({ trigger: config });
    }

    // temporary alias until 2.0.0
    if (this.instanceOf<ObservableBlockInput<T>>(config, 'observable')) {
      return this.block(this.createAliasConfig(config, 'observable'));
    }

    if (this.instanceOf<PromiseBlockInput<T>>(config, 'promise')) {
      return this.block(this.createAliasConfig(config, 'promise'));
    }

    if (this.instanceOf<SubscriptionBlockInput>(config, 'subscription')) {
      return this.block(this.createAliasConfig(config, 'subscription'));
    }

    // handle triggers
    if (this.instanceOf<TriggerBlockInput<T>>(config, 'trigger')) {
      const unblockConfig = this.createUnblockConfig(config);

      // promise
      if (this.instanceOf<Promise<T>>(config.trigger, 'then')) {
        this.block({ target: config.target, data: config.data, component: config.component });

        config.trigger.then(() => this.asyncDone(unblockConfig)).catch(() => this.asyncDone(unblockConfig));

        return config.trigger;
      }

      // observable
      if (this.instanceOf<Observable<T>>(config.trigger, 'subscribe')) {
        return config.trigger.pipe(
          doOnSubscribe(() => this.block({ target: config.target, data: config.data, component: config.component })),
          finalize(() => this.asyncDone(unblockConfig))
        );
      }

      // subscription
      if (this.instanceOf<Subscription>(config.trigger, 'unsubscribe')) {
        this.block({ target: config.target, data: config.data, component: config.component });

        config.trigger.add(() => this.asyncDone(unblockConfig));

        return config.trigger;
      }
    }

    // handle block
    const blockInput = config as BlockInput<T>;

    for (const singleTarget of this.normalizeTargets(blockInput.target)) {
      this.open(singleTarget, blockInput.data, blockInput.component);
    }
  }

  /**
   * Remove one block from target(s)
   * @param target target(s)
   */
  public unblock(target: Target | Target[] = null): void {
    for (const singleTarget of this.normalizeTargets(target)) {
      if (!this.modifyBlockerCount(singleTarget, -1)) {
        this.close(singleTarget);
      }
    }
  }

  /**
   * Remove all block from target(s) and invalidate ongoing blocks
   * @param target target(s)
   */
  public resetBlock(target: Target | Target[] = null): void {
    for (const singleTarget of this.normalizeTargets(target)) {
      this.modifyBlockerCount(singleTarget, this.blocks.get(singleTarget).count.getValue() * -1);
      this.close(singleTarget);
    }
  }

  /**
   * Get blocker count for a target
   * @param target
   * @returns observable of blocker count
   */
  public getBlockerCount(target?: Target): Observable<number> {
    if (!target) {
      return this.getBlockerCount(this.applicationRef);
    }

    return this.initOrGetBlock(target).count.asObservable();
  }

  /**
   * Get blocker component reference for a target
   * @param target
   * @returns blocker component reference
   */
  public getBlockerComponent(target?: Target): ComponentRef<any> {
    if (!target) {
      target = this.applicationRef;
    }

    if (!this.blocks.has(target)) {
      return null;
    }

    return this.blocks.get(target).component;
  }

  private createAliasConfig<T extends Trigger>(
    config: SubscriptionBlockInput | ObservableBlockInput<T> | PromiseBlockInput<T>,
    property: string
  ) {
    const triggerConfig: TriggerBlockInput<T> = { ...config };
    triggerConfig.trigger = config[property];
    delete triggerConfig[property];

    return triggerConfig;
  }

  private open(target: Target, data: any, component: Type<any>): void {
    if (!component) {
      component = target instanceof ApplicationRef ? this.defaultGlobalComponent : this.defaultSpecifiedComponent;
    }

    if (!component) {
      throw Error('Component is not defined for BlockModule!');
    }

    const block = this.initOrGetBlock(target);

    this.modifyBlockerCount(target, +1);

    if (!this.blocks.get(target).component) {
      const componentFactory = this.componentFactoryResolver.resolveComponentFactory(component);
      const componentRef = componentFactory.create(new BlockComponentInjector(this.defaultInjector, this.createInjectionMap(target, data)));
      const domElement = (componentRef.hostView as EmbeddedViewRef<any>).rootNodes[0] as HTMLElement;

      if (target instanceof ApplicationRef && this.document) {
        // ApplicationRef
        this.document.body.appendChild(domElement);
      } else if (target['element']) {
        // ViewContainerRef
        target['element'].nativeElement.appendChild(domElement);
      } else if (target['nativeElement']) {
        // ElementRef
        target['nativeElement'].appendChild(domElement);
      }

      // have to make it async to do not break change detection cycle
      setTimeout(() => {
        this.applicationRef.attachView(componentRef.hostView);
      });

      block.component = componentRef;
    }
  }

  private close(target: Target): void {
    if (!this.blocks.has(target) || !this.blocks.get(target).component) {
      return;
    }

    const component = this.blocks.get(target).component;

    if (this.blocks.get(target).count.observers.length === 0) {
      this.blocks.get(target).count.complete();
      this.blocks.delete(target);
    } else {
      this.blocks.get(target).id = null;
      this.blocks.get(target).component = null;
    }

    // has to be run in the next change detection cycle
    setTimeout(() => component.destroy());
  }

  private asyncDone(config: Unblock) {
    // do not unblock if this block was for a previous block cycle
    config.ids.filter(target => this.initOrGetBlock(target.target).id === target.id).forEach(target => {
      this.unblock(target.target);
    });

    if (config.callback) {
      config.callback();
    }
  }

  private instanceOf<T>(object: any, propertyName: keyof T): object is T {
    return object && propertyName in object;
  }

  private createUnblockConfig<T>(config: BlockInput<T>): Unblock {
    const unblockConfig: Unblock = { callback: config.callback, ids: [] };

    for (const singleTarget of this.normalizeTargets(config.target)) {
      unblockConfig.ids.push({ target: singleTarget, id: this.initOrGetBlock(singleTarget).id });
    }

    return unblockConfig;
  }

  private initOrGetBlock(target: Target): Block {
    if (!this.blocks.has(target)) {
      this.blocks.set(target, { id: null, component: null, count: new BehaviorSubject<number>(0) });
    }

    const block = this.blocks.get(target);

    if (!block.id) {
      block.id = Math.floor(Math.random() * 100000000);
    }

    return block;
  }

  private modifyBlockerCount(target: Target, count: number): number {
    if (!this.blocks.has(target)) {
      return 0;
    }

    this.blocks.get(target).count.next(Math.max(0, this.blocks.get(target).count.value + count));

    return this.blocks.get(target).count.value;
  }

  private normalizeTargets(targets: Target | Target[]): Target[] {
    if (targets && !Array.isArray(targets)) {
      return [targets];
    }

    if (Array.isArray(targets)) {
      return targets;
    }

    return [this.applicationRef];
  }

  private createInjectionMap(target: Target, data: any = {}): WeakMap<any, any> {
    const map = new WeakMap<any, any>();
    map.set(BLOCK_DATA, data);
    map.set(BLOCK_BLOCKER_COUNT, this.getBlockerCount(target));
    map.set(BLOCK_TARGET, target);

    return map;
  }
}
