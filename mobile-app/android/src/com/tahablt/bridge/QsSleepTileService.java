package com.tahablt.bridge;

public class QsSleepTileService extends QsMonitorsOnTileService {
    @Override protected String getActionKey() { return "sleep"; }
    @Override protected String getBaseTitle() { return "Uyku"; }
    @Override protected int getIconRes() { return R.drawable.qs_icon_sleep; }
}
