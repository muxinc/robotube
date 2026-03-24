import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useCallback, useState } from "react";
import { Platform } from "react-native";

export function useNativeSearch(onSearch: (query: string) => void) {
  const navigation = useNavigation();
  const [searchText, setSearchText] = useState("");
  const isIOS = Platform.OS === "ios";

  const handleSearchChange = useCallback((text: string) => {
    setSearchText(text);
  }, []);

  const handleSearchSubmit = useCallback(() => {
    if (searchText.trim().length >= 2) {
      onSearch(searchText.trim());
    }
  }, [searchText, onSearch]);

  useLayoutEffect(() => {
    if (!isIOS) return;

    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Search videos, tags, or topics",
        onChangeText: (event: any) => {
          const text = event.nativeEvent.text || "";
          handleSearchChange(text);
        },
        onSearchButtonPress: handleSearchSubmit,
        onCancelButtonPress: () => {
          setSearchText("");
        },
        hideWhenScrolling: false,
        autoFocus: true,
        textColor: "#000",
      },
    });
  }, [navigation, isIOS, handleSearchChange, handleSearchSubmit]);

  return { searchText, setSearchText };
}