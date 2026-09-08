'use client'

import { Icon } from '@iconify/react'
import addCircleOutline from '@iconify-icons/solar/add-circle-outline'
import altArrowDownOutline from '@iconify-icons/solar/alt-arrow-down-outline'
import arrowRightUpOutline from '@iconify-icons/solar/arrow-right-up-outline'
import boltOutline from '@iconify-icons/solar/bolt-outline'
import checkCircleOutline from '@iconify-icons/solar/check-circle-outline'
import checkReadOutline from '@iconify-icons/solar/check-read-outline'
import closeCircleOutline from '@iconify-icons/solar/close-circle-outline'
import hamburgerMenuOutline from '@iconify-icons/solar/hamburger-menu-outline'
import logoutOutline from '@iconify-icons/solar/logout-outline'
import magniferOutline from '@iconify-icons/solar/magnifer-outline'
import monitorOutline from '@iconify-icons/solar/monitor-outline'
import moonOutline from '@iconify-icons/solar/moon-outline'
import pulseOutline from '@iconify-icons/solar/pulse-outline'
import replyOutline from '@iconify-icons/solar/reply-outline'
import settingsOutline from '@iconify-icons/solar/settings-outline'
import shieldCheckOutline from '@iconify-icons/solar/shield-check-outline'
import sidebarMinimalisticOutline from '@iconify-icons/solar/sidebar-minimalistic-outline'
import sunOutline from '@iconify-icons/solar/sun-outline'
import tuning2Outline from '@iconify-icons/solar/tuning-2-outline'
import usersGroupRoundedOutline from '@iconify-icons/solar/users-group-rounded-outline'
import usersGroupTwoRoundedOutline from '@iconify-icons/solar/users-group-two-rounded-outline'
import widget2Outline from '@iconify-icons/solar/widget-2-outline'

/*
 * Solar Outline icons (480 Design, CC BY 4.0) via Iconify — tree-shaken
 * per-icon imports. Single source of truth for every glyph in Keyring.
 */
const ICONS = {
  overview: widget2Outline,
  actions: boltOutline,
  roles: shieldCheckOutline,
  members: usersGroupRoundedOutline,
  users: usersGroupTwoRoundedOutline,
  activity: pulseOutline,
  search: magniferOutline,
  plus: addCircleOutline,
  customize: tuning2Outline,
  sun: sunOutline,
  moon: moonOutline,
  monitor: monitorOutline,
  logout: logoutOutline,
  chevronDown: altArrowDownOutline,
  check: checkCircleOutline,
  checkPlain: checkReadOutline,
  close: closeCircleOutline,
  menu: hamburgerMenuOutline,
  arrowUpRight: arrowRightUpOutline,
  sidebar: sidebarMinimalisticOutline,
  reply: replyOutline,
  settings: settingsOutline,
} as const

export type SolarName = keyof typeof ICONS

export function SolarIcon({ name, className }: { name: SolarName; className?: string }) {
  return <Icon icon={ICONS[name]} className={className} aria-hidden />
}
