/**
 * The theme control in the navbar: a menu of Light / Dark / System
 * rather than a two-state switch.
 *
 * A switch can only express "light or dark", which silently drops the
 * default — following the OS — and leaves a user who wants it back with
 * no way to ask (see `ColorModeProvider` for why that default matters).
 * Three explicit options cost one extra click and keep the preference
 * honest.
 *
 * The button's icon shows what's currently *rendered*, not what was
 * chosen, so on "System" it tracks the OS: that's the information
 * someone glancing at the bar actually wants, and the checkmark inside
 * the menu is where the chosen setting is shown.
 */
import { useState } from 'react'
import { IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip } from '@mui/material'
import LightModeIcon from '@mui/icons-material/LightMode'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import SettingsBrightnessIcon from '@mui/icons-material/SettingsBrightness'
import CheckIcon from '@mui/icons-material/Check'
import { useColorMode } from '../../theme/colorModeContext'

const OPTIONS = [
  { value: 'light', label: 'Light', icon: LightModeIcon },
  { value: 'dark', label: 'Dark', icon: DarkModeIcon },
  { value: 'system', label: 'System', icon: SettingsBrightnessIcon },
]

export default function ColorModeToggle() {
  const { mode, resolvedMode, setMode } = useColorMode()
  const [anchorEl, setAnchorEl] = useState(null)

  const CurrentIcon = resolvedMode === 'dark' ? DarkModeIcon : LightModeIcon

  return (
    <>
      <Tooltip title={`Theme: ${OPTIONS.find((option) => option.value === mode)?.label}`}>
        <IconButton
          onClick={(event) => setAnchorEl(event.currentTarget)}
          aria-label="Change theme"
          aria-haspopup="menu"
          size="small"
        >
          <CurrentIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <MenuItem
            key={value}
            selected={value === mode}
            onClick={() => {
              setMode(value)
              setAnchorEl(null)
            }}
            sx={{ minWidth: 176 }}
          >
            <ListItemIcon>
              <Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText slotProps={{ primary: { variant: 'body2' } }}>{label}</ListItemText>
            {value === mode && <CheckIcon fontSize="small" sx={{ ml: 1, color: 'primary.main' }} />}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
