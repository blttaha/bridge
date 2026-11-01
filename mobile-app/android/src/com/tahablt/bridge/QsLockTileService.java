package com.tahablt.bridge;

import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.quicksettings.Tile;

public class QsLockTileService extends QsMonitorsOnTileService {
    @Override protected String getActionKey() { return "toggle_lock"; }
    @Override protected String getBaseTitle() { return "Kilitle"; }
    @Override protected int getIconRes() { return R.drawable.qs_icon_lock; }

    @Override
    public void onStartListening() {
        refreshTile();
        MainActivity.queryDeviceLockStateAsync(this, getSlotIndex(), this::refreshTile);
    }

    @Override
    public void onClick() {
        boolean currentlyLocked = MainActivity.isDeviceLockedForSlot(this, getSlotIndex());
        String devId = MainActivity.getDeviceIdForSlot(this, getSlotIndex());
        if (!devId.isEmpty()) {
            MainActivity.setDeviceLockedForId(this, devId, !currentlyLocked);
        }
        refreshTile();
        MainActivity.executeQuickDeviceActionForSlot(this, getActionKey(), getSlotIndex());
    }

    @Override
    protected void refreshTile() {
        try {
            Tile tile = getQsTile();
            if (tile == null) return;
            boolean locked = MainActivity.isDeviceLockedForSlot(this, getSlotIndex());
            String devName = MainActivity.getShortDeviceNameForSlot(this, getSlotIndex());

            tile.setIcon(Icon.createWithResource(this, locked ? R.drawable.qs_icon_lock : R.drawable.qs_icon_unlock));
            tile.setLabel(locked ? "Kilitli" : "Kilitle");
            if (Build.VERSION.SDK_INT >= 29) {
                tile.setSubtitle(devName.isEmpty() ? (locked ? "PC Kilitli" : "PC Açık") : devName);
            }
            tile.setState(locked ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
            tile.updateTile();
        } catch (Exception ignored) {
        }
    }
}
